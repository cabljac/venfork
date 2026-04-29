import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { parseRepoPath } from './utils.js';

/**
 * Record kept by `venfork stage --pr` linking an internal review PR (on the
 * private mirror) to the upstream PR it was promoted to.
 */
export interface ShippedBranch {
  upstreamPrUrl: string;
  /** SHA pushed to the public fork (== HEAD of the staged branch). */
  head: string;
  /** ISO timestamp when ship completed. */
  shippedAt: string;
  /** Internal-mirror PR URL, omitted if the branch had no internal PR. */
  internalPrUrl?: string;
}

/**
 * Record kept by `venfork pull-request` so `venfork sync <branch>` can
 * refresh a pulled-in upstream PR against the latest `pull/<n>/head` ref.
 */
export interface PulledPr {
  upstreamPrNumber: number;
  upstreamPrUrl: string;
  /** SHA last fetched onto the local branch. Used for "no-op sync" detection. */
  head: string;
  /** ISO timestamp of the last successful fetch. */
  lastSyncedAt: string;
}

/**
 * Record kept by `venfork issue stage` linking an internal issue (private
 * mirror) to the upstream issue it was promoted to.
 */
export interface ShippedIssue {
  internalIssueNumber: number;
  internalIssueUrl: string;
  upstreamIssueNumber: number;
  upstreamIssueUrl: string;
  /** ISO timestamp when ship completed. */
  shippedAt: string;
}

/**
 * Record kept by `venfork issue pull` linking an upstream issue to the
 * internal issue created on the mirror for team triage.
 */
export interface PulledIssue {
  upstreamIssueNumber: number;
  upstreamIssueUrl: string;
  internalIssueNumber: number;
  internalIssueUrl: string;
  /** ISO timestamp when the internal issue was created. */
  pulledAt: string;
}

/**
 * Venfork configuration structure.
 */
export interface VenforkConfig {
  version: string;
  /**
   * Repo layout. `'standard'` (default when absent) is the three-remote
   * setup with a public fork hop. `'no-public'` collapses the layout to
   * `origin` (private mirror) + `upstream` only — used when the upstream
   * repo lives in the user's own org so the fork hop is unnecessary.
   */
  mode?: 'standard' | 'no-public';
  /** Required in `'standard'` mode; omitted in `'no-public'` mode. */
  publicForkUrl?: string;
  upstreamUrl: string;
  schedule?: {
    cron: string;
    enabled: boolean;
  };
  enabledWorkflows?: string[];
  disabledWorkflows?: string[];
  /**
   * Allowlist of mirror-only file paths to carry forward across `venfork sync`.
   *
   * Each entry must be a clean repo-relative path:
   *   - no leading `/`
   *   - no `..`, `.`, or empty path segments
   *   - no backslashes, NUL bytes, Windows drive prefixes (e.g. `C:`)
   *   - no whitespace anywhere in the path
   *
   * Whitespace is forbidden so the divergence-error hint
   * (`venfork preserve add <path>`) stays copy/paste-safe without quoting.
   * Entries that don't match are dropped during config normalization.
   *
   * On sync, every listed path is read from the previous mirror tip
   * (`origin/<defaultBranch>`) and re-added to the deterministic "+1 commit"
   * — unless upstream now contains the same path, in which case upstream wins.
   */
  preserve?: string[];
  /** Branch -> upstream PR linkage recorded by `venfork stage --pr`. */
  shippedBranches?: Record<string, ShippedBranch>;
  /** Branch -> upstream PR tracking recorded by `venfork pull-request`. */
  pulledPrs?: Record<string, PulledPr>;
  /**
   * Internal-issue-number-as-string -> upstream issue linkage recorded by
   * `venfork issue stage`.
   */
  shippedIssues?: Record<string, ShippedIssue>;
  /**
   * Internal-issue-number-as-string -> upstream issue linkage recorded by
   * `venfork issue pull`.
   */
  pulledIssues?: Record<string, PulledIssue>;
}

const CONFIG_BRANCH = 'venfork-config';
const CONFIG_DIR = '.venfork';
const CONFIG_FILE = 'config.json';
const UPDATE_CONFIG_COMMIT_MESSAGE = 'chore: update venfork configuration';
const VENFORK_BOT_NAME = 'venfork-bot';
const VENFORK_BOT_EMAIL = 'venfork-bot@users.noreply.github.com';

export type VenforkConfigPatch = Omit<
  Partial<VenforkConfig>,
  | 'enabledWorkflows'
  | 'disabledWorkflows'
  | 'preserve'
  | 'shippedBranches'
  | 'pulledPrs'
  | 'shippedIssues'
  | 'pulledIssues'
> & {
  enabledWorkflows?: string[] | null;
  disabledWorkflows?: string[] | null;
  preserve?: string[] | null;
  /**
   * Shallow merge into the existing map. Pass `null` for an entry to delete
   * just that branch, or `null` for the whole field to clear the map.
   */
  shippedBranches?: Record<string, ShippedBranch | null> | null;
  /** Same shape as `shippedBranches` for pulled-PR tracking. */
  pulledPrs?: Record<string, PulledPr | null> | null;
  shippedIssues?: Record<string, ShippedIssue | null> | null;
  pulledIssues?: Record<string, PulledIssue | null> | null;
};

/**
 * Creates and pushes a venfork config branch to the origin remote.
 *
 * Pass `publicForkUrl: null` (with `mode: 'no-public'`) when the layout
 * skips the public fork hop.
 */
export async function createConfigBranch(
  repoDir: string,
  publicForkUrl: string | null,
  upstreamUrl: string,
  mode: 'standard' | 'no-public' = 'standard'
): Promise<void> {
  const config: VenforkConfig = {
    version: '1',
    upstreamUrl,
  };
  if (mode === 'no-public') {
    config.mode = 'no-public';
  } else {
    if (!publicForkUrl) {
      throw new Error(
        'createConfigBranch: publicForkUrl is required for standard mode'
      );
    }
    config.publicForkUrl = publicForkUrl;
  }

  await writeConfigBranch(repoDir, config, 'Initialize venfork configuration');
}

/**
 * Detects a `git push --force-with-lease` rejection due to upstream having
 * moved since we read it. Distinguishes from auth/network failures (which
 * should NOT trigger a config-write retry).
 */
function isLeaseFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /stale info/i.test(msg) || /\[rejected\][^\n]*stale/i.test(msg);
}

async function writeConfigBranch(
  repoDir: string,
  config: VenforkConfig,
  commitMessage: string,
  options: { expectedSha?: string } = {}
): Promise<void> {
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-${uniqueId}`);

  try {
    await mkdir(path.join(tempDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      path.join(tempDir, CONFIG_DIR, CONFIG_FILE),
      JSON.stringify(config, null, 2)
    );

    await $({ cwd: tempDir })`git init`;
    await $({ cwd: tempDir })`git checkout --orphan ${CONFIG_BRANCH}`;
    await $({ cwd: tempDir })`git add ${CONFIG_DIR}/${CONFIG_FILE}`;
    await $({
      cwd: tempDir,
    })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit -m ${commitMessage}`;

    const remoteResult = await $({ cwd: repoDir })`git remote get-url origin`;
    const originUrl = remoteResult.stdout.trim();

    // Caller-supplied lease wins — it's the SHA that was actually read,
    // which is the only correct lease (a fresh ls-remote here would race
    // with a concurrent writer who pushed between our read and our push).
    // Fall back to ls-remote when no SHA is supplied, for first-time writes
    // (`createConfigBranch`) and any callers that haven't been updated.
    let expectedSha = options.expectedSha ?? '';
    if (!expectedSha) {
      const lsRemote = await $({
        cwd: tempDir,
        reject: false,
      })`git ls-remote ${originUrl} ${CONFIG_BRANCH}`;
      expectedSha =
        lsRemote.exitCode === 0
          ? (lsRemote.stdout.trim().split(/\s+/)[0] ?? '')
          : '';
    }
    if (expectedSha) {
      await $({
        cwd: tempDir,
      })`git push ${originUrl} ${CONFIG_BRANCH}:${CONFIG_BRANCH} --force-with-lease=${CONFIG_BRANCH}:${expectedSha}`;
    } else {
      // First-time write: no upstream to lease against; concurrent writers
      // can't exist yet because the branch doesn't yet exist.
      await $({
        cwd: tempDir,
      })`git push ${originUrl} ${CONFIG_BRANCH}:${CONFIG_BRANCH}`;
    }
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function normalizeShippedBranch(value: unknown): ShippedBranch | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ShippedBranch>;
  if (
    typeof v.upstreamPrUrl !== 'string' ||
    !v.upstreamPrUrl.trim() ||
    typeof v.head !== 'string' ||
    !v.head.trim() ||
    typeof v.shippedAt !== 'string' ||
    !v.shippedAt.trim()
  ) {
    return null;
  }
  const out: ShippedBranch = {
    upstreamPrUrl: v.upstreamPrUrl,
    head: v.head,
    shippedAt: v.shippedAt,
  };
  if (typeof v.internalPrUrl === 'string' && v.internalPrUrl.trim()) {
    out.internalPrUrl = v.internalPrUrl;
  }
  return out;
}

/**
 * GitHub PR / issue numbers are always positive integers. Reject anything
 * else so a hand-edited config with garbage numbers (negatives, floats, NaN)
 * doesn't leak into runtime.
 */
function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function normalizePulledPr(value: unknown): PulledPr | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<PulledPr>;
  if (
    !isPositiveInt(v.upstreamPrNumber) ||
    typeof v.upstreamPrUrl !== 'string' ||
    !v.upstreamPrUrl.trim() ||
    typeof v.head !== 'string' ||
    !v.head.trim() ||
    typeof v.lastSyncedAt !== 'string' ||
    !v.lastSyncedAt.trim()
  ) {
    return null;
  }
  return {
    upstreamPrNumber: v.upstreamPrNumber,
    upstreamPrUrl: v.upstreamPrUrl,
    head: v.head,
    lastSyncedAt: v.lastSyncedAt,
  };
}

function normalizeShippedIssue(value: unknown): ShippedIssue | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ShippedIssue>;
  if (
    !isPositiveInt(v.internalIssueNumber) ||
    typeof v.internalIssueUrl !== 'string' ||
    !v.internalIssueUrl.trim() ||
    !isPositiveInt(v.upstreamIssueNumber) ||
    typeof v.upstreamIssueUrl !== 'string' ||
    !v.upstreamIssueUrl.trim() ||
    typeof v.shippedAt !== 'string' ||
    !v.shippedAt.trim()
  ) {
    return null;
  }
  return {
    internalIssueNumber: v.internalIssueNumber,
    internalIssueUrl: v.internalIssueUrl,
    upstreamIssueNumber: v.upstreamIssueNumber,
    upstreamIssueUrl: v.upstreamIssueUrl,
    shippedAt: v.shippedAt,
  };
}

function normalizePulledIssue(value: unknown): PulledIssue | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<PulledIssue>;
  if (
    !isPositiveInt(v.upstreamIssueNumber) ||
    typeof v.upstreamIssueUrl !== 'string' ||
    !v.upstreamIssueUrl.trim() ||
    !isPositiveInt(v.internalIssueNumber) ||
    typeof v.internalIssueUrl !== 'string' ||
    !v.internalIssueUrl.trim() ||
    typeof v.pulledAt !== 'string' ||
    !v.pulledAt.trim()
  ) {
    return null;
  }
  return {
    upstreamIssueNumber: v.upstreamIssueNumber,
    upstreamIssueUrl: v.upstreamIssueUrl,
    internalIssueNumber: v.internalIssueNumber,
    internalIssueUrl: v.internalIssueUrl,
    pulledAt: v.pulledAt,
  };
}

/**
 * Validates a single `preserve` entry. Rejects (returns null) anything that
 * isn't a clean repo-relative path: empty/whitespace-only, NUL bytes,
 * leading `/`, backslashes, Windows drive prefixes, or `..` / `.` / empty
 * segments. Whitespace anywhere in the value is rejected too — preserve
 * paths surface verbatim in the divergence-error hint
 * (`venfork preserve add <path>`), so disallowing whitespace keeps that
 * copy/paste-safe without quoting and rules out an entire bug class for a
 * negligible cost (workflow/script paths conventionally don't use spaces).
 */
export function normalizePreservePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\0')) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.startsWith('/')) return null;
  if (trimmed.includes('\\')) return null;
  if (/^[A-Za-z]:/.test(trimmed)) return null;
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return null;
    }
  }
  return trimmed;
}

function normalizeBranchMap<T>(
  source: Record<string, unknown> | undefined,
  perEntry: (value: unknown) => T | null
): Record<string, T> | null {
  if (!source || typeof source !== 'object') return null;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.trim()) continue;
    const normalized = perEntry(value);
    if (normalized) {
      out[key] = normalized;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeConfig(config: VenforkConfig): VenforkConfig | null {
  if (!config.version || !config.upstreamUrl) {
    return null;
  }

  const mode: 'standard' | 'no-public' =
    config.mode === 'no-public' ? 'no-public' : 'standard';

  if (mode === 'standard' && !config.publicForkUrl) {
    return null;
  }
  if (mode === 'no-public' && config.publicForkUrl) {
    // mode/publicForkUrl must agree — reject the ambiguous combo so a
    // hand-edit can't leave the config in a contradictory state.
    return null;
  }

  const normalized: VenforkConfig = {
    ...config,
  };
  if (mode === 'no-public') {
    normalized.mode = 'no-public';
    delete normalized.publicForkUrl;
  } else {
    delete normalized.mode;
  }

  if (normalized.schedule) {
    const cron = normalized.schedule.cron?.trim();
    if (!cron || typeof normalized.schedule.enabled !== 'boolean') {
      return null;
    }
    normalized.schedule = {
      cron,
      enabled: normalized.schedule.enabled,
    };
  }

  if (normalized.enabledWorkflows) {
    const cleaned = Array.from(
      new Set(
        normalized.enabledWorkflows
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .sort()
      )
    );
    if (cleaned.length > 0) {
      normalized.enabledWorkflows = cleaned;
    } else {
      delete normalized.enabledWorkflows;
    }
  }

  if (normalized.disabledWorkflows) {
    const cleaned = Array.from(
      new Set(
        normalized.disabledWorkflows
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .sort()
      )
    );
    if (cleaned.length > 0) {
      normalized.disabledWorkflows = cleaned;
    } else {
      delete normalized.disabledWorkflows;
    }
  }

  if (normalized.preserve) {
    const cleaned = Array.from(
      new Set(
        normalized.preserve
          .map((value) => normalizePreservePath(value))
          .filter((value): value is string => value !== null)
          .sort()
      )
    );
    if (cleaned.length > 0) {
      normalized.preserve = cleaned;
    } else {
      delete normalized.preserve;
    }
  }

  const shippedBranches = normalizeBranchMap(
    normalized.shippedBranches,
    normalizeShippedBranch
  );
  if (shippedBranches) {
    normalized.shippedBranches = shippedBranches;
  } else {
    delete normalized.shippedBranches;
  }

  const pulledPrs = normalizeBranchMap(normalized.pulledPrs, normalizePulledPr);
  if (pulledPrs) {
    normalized.pulledPrs = pulledPrs;
  } else {
    delete normalized.pulledPrs;
  }

  const shippedIssues = normalizeBranchMap(
    normalized.shippedIssues,
    normalizeShippedIssue
  );
  if (shippedIssues) {
    normalized.shippedIssues = shippedIssues;
  } else {
    delete normalized.shippedIssues;
  }

  const pulledIssues = normalizeBranchMap(
    normalized.pulledIssues,
    normalizePulledIssue
  );
  if (pulledIssues) {
    normalized.pulledIssues = pulledIssues;
  } else {
    delete normalized.pulledIssues;
  }

  return normalized;
}

/**
 * Fetches and reads the venfork config from a remote repository.
 */
export async function fetchVenforkConfig(
  repoUrl: string
): Promise<VenforkConfig | null> {
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-read-${uniqueId}`);

  try {
    const repoRef = parseRepoPath(repoUrl) || repoUrl;
    const cloneResult = await $({
      reject: false,
    })`gh repo clone ${repoRef} ${tempDir} -- --branch ${CONFIG_BRANCH} --single-branch --depth 1`;

    if (cloneResult.exitCode !== 0) {
      return null;
    }

    const rawConfig = await readFile(
      path.join(tempDir, CONFIG_DIR, CONFIG_FILE),
      'utf-8'
    );
    const config = JSON.parse(rawConfig) as VenforkConfig;
    return normalizeConfig(config);
  } catch {
    return null;
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Atomically reads the config content + the SHA of the commit it came from
 * by running fetch once and resolving both `FETCH_HEAD` (for the SHA) and
 * `FETCH_HEAD:<config>` (for the content) against that single fetch. Returns
 * null if the branch doesn't exist or the content is unreadable.
 *
 * Capturing the SHA here is what lets `updateVenforkConfig` push back with
 * an explicit `--force-with-lease=<branch>:<sha>` against the *exact* SHA
 * we read from — the only lease that's safe under concurrent writers.
 */
async function fetchConfigContentAndSha(
  repoDir: string
): Promise<{ raw: string; sha: string } | null> {
  const fetchResult = await $({
    cwd: repoDir,
    reject: false,
  })`git fetch origin ${CONFIG_BRANCH}`;
  if (fetchResult.exitCode !== 0) {
    return null;
  }

  const revParseResult = await $({
    cwd: repoDir,
    reject: false,
  })`git rev-parse FETCH_HEAD`;
  if (revParseResult.exitCode !== 0) {
    return null;
  }
  const sha = revParseResult.stdout.trim();
  if (!sha) {
    return null;
  }

  const showResult = await $({
    cwd: repoDir,
    reject: false,
  })`git show FETCH_HEAD:${CONFIG_DIR}/${CONFIG_FILE}`;
  if (showResult.exitCode !== 0) {
    return null;
  }
  return { raw: showResult.stdout, sha };
}

/**
 * Reads venfork configuration from the local repo's orphan `venfork-config` branch.
 */
export async function readVenforkConfigFromRepo(
  repoDir: string
): Promise<VenforkConfig | null> {
  const fetched = await fetchConfigContentAndSha(repoDir);
  if (!fetched) return null;
  try {
    const config = JSON.parse(fetched.raw) as VenforkConfig;
    return normalizeConfig(config);
  } catch {
    return null;
  }
}

/**
 * Like `readVenforkConfigFromRepo` but also returns the SHA of the commit
 * the config was read from. Used by `updateVenforkConfig` so the
 * subsequent push can lease against that SHA.
 */
async function readVenforkConfigFromRepoWithSha(
  repoDir: string
): Promise<{ config: VenforkConfig; sha: string } | null> {
  const fetched = await fetchConfigContentAndSha(repoDir);
  if (!fetched) return null;
  try {
    const config = JSON.parse(fetched.raw) as VenforkConfig;
    const normalized = normalizeConfig(config);
    if (!normalized) return null;
    return { config: normalized, sha: fetched.sha };
  } catch {
    return null;
  }
}

/**
 * Apply a `VenforkConfigPatch` on top of an already-read config and return
 * the fully merged + normalized result. Pulled out so the retry loop in
 * `updateVenforkConfig` can re-apply the same patch to freshly-read state
 * after a `--force-with-lease` failure.
 */
function applyPatchAndNormalize(
  current: VenforkConfig,
  patch: VenforkConfigPatch
): VenforkConfig {
  const {
    enabledWorkflows: _enabledWorkflowsPatch,
    disabledWorkflows: _disabledWorkflowsPatch,
    preserve: _preservePatch,
    shippedBranches: _shippedBranchesPatch,
    pulledPrs: _pulledPrsPatch,
    shippedIssues: _shippedIssuesPatch,
    pulledIssues: _pulledIssuesPatch,
    ...basePatch
  } = patch;

  const merged: VenforkConfig = {
    ...current,
    ...basePatch,
    schedule: basePatch.schedule
      ? {
          ...current.schedule,
          ...basePatch.schedule,
        }
      : current.schedule,
  };

  if (patch.enabledWorkflows === null) {
    delete merged.enabledWorkflows;
  } else if (patch.enabledWorkflows !== undefined) {
    merged.enabledWorkflows = patch.enabledWorkflows;
  }

  if (patch.disabledWorkflows === null) {
    delete merged.disabledWorkflows;
  } else if (patch.disabledWorkflows !== undefined) {
    merged.disabledWorkflows = patch.disabledWorkflows;
  }

  if (patch.preserve === null) {
    delete merged.preserve;
  } else if (patch.preserve !== undefined) {
    merged.preserve = patch.preserve;
  }

  if (patch.shippedBranches === null) {
    delete merged.shippedBranches;
  } else if (patch.shippedBranches !== undefined) {
    merged.shippedBranches = mergeBranchMap(
      merged.shippedBranches,
      patch.shippedBranches
    );
  }

  if (patch.pulledPrs === null) {
    delete merged.pulledPrs;
  } else if (patch.pulledPrs !== undefined) {
    merged.pulledPrs = mergeBranchMap(merged.pulledPrs, patch.pulledPrs);
  }

  if (patch.shippedIssues === null) {
    delete merged.shippedIssues;
  } else if (patch.shippedIssues !== undefined) {
    merged.shippedIssues = mergeBranchMap(
      merged.shippedIssues,
      patch.shippedIssues
    );
  }

  if (patch.pulledIssues === null) {
    delete merged.pulledIssues;
  } else if (patch.pulledIssues !== undefined) {
    merged.pulledIssues = mergeBranchMap(
      merged.pulledIssues,
      patch.pulledIssues
    );
  }

  if (merged.schedule && !merged.schedule.cron?.trim()) {
    throw new Error('schedule.cron is required when schedule is configured');
  }

  const normalized = normalizeConfig(merged);
  if (!normalized) {
    throw new Error('Updated venfork config is invalid');
  }
  return normalized;
}

/**
 * Updates and force-pushes `venfork-config` with a shallow merge patch.
 *
 * Auto-retries on `--force-with-lease` failure (i.e. another venfork
 * command pushed between our read and our write). Each retry re-reads
 * the now-updated config, re-applies the same patch on top, and pushes
 * again with the fresh lease SHA — so the losing run's update is
 * preserved on top of the winning run's, instead of being dropped or
 * surfaced as a confusing error to the user. Bounded at 3 attempts so
 * pathological live-locks don't hang the CLI.
 */
export async function updateVenforkConfig(
  repoDir: string,
  patch: VenforkConfigPatch
): Promise<VenforkConfig> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const read = await readVenforkConfigFromRepoWithSha(repoDir);
    if (!read) {
      throw new Error('venfork-config branch not found or invalid');
    }

    const normalized = applyPatchAndNormalize(read.config, patch);

    try {
      await writeConfigBranch(
        repoDir,
        normalized,
        UPDATE_CONFIG_COMMIT_MESSAGE,
        {
          expectedSha: read.sha,
        }
      );
      return normalized;
    } catch (err) {
      if (isLeaseFailure(err) && attempt < MAX_RETRIES - 1) {
        // Another venfork command updated the config between our read and
        // our push. Re-read on the next iteration so the merge is on top
        // of their winning content.
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Could not update venfork-config after ${MAX_RETRIES} concurrent-write retries. Re-run the command, or resolve any unexpected state on the venfork-config branch.`
  );
}

/**
 * Apply a partial patch to a branch-keyed map. Per-entry `null` deletes the
 * entry; absent entries are preserved. Returns undefined when the result is
 * empty so the field gets removed from the config object.
 */
function mergeBranchMap<T>(
  current: Record<string, T> | undefined,
  patch: Record<string, T | null>
): Record<string, T> | undefined {
  const merged: Record<string, T> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

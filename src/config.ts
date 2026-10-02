import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { ConfigError, GitError } from './errors.js';
import { SYNC_WORKFLOW_PATH } from './shared/constants.js';
import { isValidCronExpression } from './shared/cron.js';
import { netExec, netFailureReason } from './shared/net.js';
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
   *   - no leading `-` (would parse as a flag in `git add`/etc.)
   *   - no `..`, `.`, or empty path segments
   *   - no backslashes, NUL bytes, Windows drive prefixes (e.g. `C:`)
   *   - no whitespace anywhere in the path
   *   - no glob characters (`*`, `?`, `[`, `]`) and no leading `:` (git
   *     pathspec magic); entries are single files, never patterns
   *   - not the managed sync workflow (or a path below it) and nothing under
   *     `.venfork/`: venfork owns those
   *
   * Whitespace is forbidden so the divergence-error hint
   * (`venfork preserve add <path>`) stays copy/paste-safe without quoting.
   * Entries that don't match move to `invalidPreserve` during normalization.
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
  /**
   * In memory only: `preserve` entries from the branch that fail
   * validation. They are written back into `preserve` on save, and sync and
   * schedule refuse to run while any remain.
   */
  invalidPreserve?: string[];
}

const CONFIG_BRANCH = 'venfork-config';
const CONFIG_DIR = '.venfork';
const CONFIG_FILE = 'config.json';
const UPDATE_CONFIG_COMMIT_MESSAGE = 'chore: update venfork configuration';
const VENFORK_BOT_NAME = 'venfork-bot';
const VENFORK_BOT_EMAIL = 'venfork-bot@users.noreply.github.com';

export type VenforkConfigPatch = Omit<
  Partial<VenforkConfig>,
  | 'schedule'
  | 'invalidPreserve'
  | 'enabledWorkflows'
  | 'disabledWorkflows'
  | 'preserve'
  | 'shippedBranches'
  | 'pulledPrs'
  | 'shippedIssues'
  | 'pulledIssues'
> & {
  /** Merged into the current schedule; `null` removes it. */
  schedule?: VenforkConfig['schedule'] | null;
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
 * Creates and pushes a venfork config branch to the origin remote. Refuses
 * with a {@link ConfigError} when origin already has one.
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

  const probe = await netExec(repoDir, {
    bufferOutput: true,
  })`git ls-remote --exit-code origin refs/heads/${CONFIG_BRANCH}`;
  if (probe.exitCode === 0) {
    throw new ConfigError(
      `The ${CONFIG_BRANCH} branch already exists on origin; refusing to overwrite it. Use \`venfork clone\` to work with an existing mirror.`,
      { reason: 'exists' }
    );
  }
  if (probe.exitCode !== 2) {
    throw new ConfigError(
      `Could not check origin for the ${CONFIG_BRANCH} branch: ${netFailureReason(probe)}`,
      { reason: 'fetch' }
    );
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

/** Pushes `config` as a new `venfork-config` commit and returns its SHA. */
async function writeConfigBranch(
  repoDir: string,
  config: VenforkConfig,
  commitMessage: string,
  options: { expectedSha?: string } = {}
): Promise<string> {
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-${uniqueId}`);

  try {
    await mkdir(path.join(tempDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      path.join(tempDir, CONFIG_DIR, CONFIG_FILE),
      JSON.stringify(toPersisted(config), null, 2)
    );

    await $({ cwd: tempDir })`git init`;
    await $({ cwd: tempDir })`git checkout --orphan ${CONFIG_BRANCH}`;
    await $({ cwd: tempDir })`git add -- ${CONFIG_DIR}/${CONFIG_FILE}`;
    await $({
      cwd: tempDir,
    })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit -m ${commitMessage}`;
    const written = (
      await $({ cwd: tempDir })`git rev-parse HEAD`
    ).stdout.trim();

    const remoteResult = await $({ cwd: repoDir })`git remote get-url origin`;
    const originUrl = remoteResult.stdout.trim();

    // Caller-supplied lease wins — it's the SHA that was actually read,
    // which is the only correct lease (a fresh ls-remote here would race
    // with a concurrent writer who pushed between our read and our push).
    // Fall back to ls-remote when no SHA is supplied, for first-time writes
    // (`createConfigBranch`) and any callers that haven't been updated.
    let expectedSha = options.expectedSha ?? '';
    if (!expectedSha) {
      const lsRemote = await netExec(tempDir, {
        bufferOutput: true,
      })`git ls-remote ${originUrl} ${CONFIG_BRANCH}`;
      expectedSha =
        lsRemote.exitCode === 0
          ? ((lsRemote.stdout ?? '').trim().split(/\s+/)[0] ?? '')
          : '';
    }
    // First-time write has no lease: the branch does not exist yet.
    const push = expectedSha
      ? await netExec(tempDir, {
          bufferOutput: true,
        })`git push ${originUrl} ${CONFIG_BRANCH}:${CONFIG_BRANCH} --force-with-lease=${CONFIG_BRANCH}:${expectedSha} --no-follow-tags`
      : await netExec(tempDir, {
          bufferOutput: true,
        })`git push ${originUrl} ${CONFIG_BRANCH}:${CONFIG_BRANCH} --no-follow-tags`;
    if (push.exitCode !== 0) {
      throw new GitError(
        `git push ${CONFIG_BRANCH} failed: ${netFailureReason(push)}`,
        'git push'
      );
    }
    return written;
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
 * True for the managed sync workflow, any path below it, and anything under
 * `.venfork/`: venfork writes these itself, so they can never be preserved.
 *
 * @param entry Repo-relative path.
 */
export function isVenforkOwnedPath(entry: string): boolean {
  return (
    entry === SYNC_WORKFLOW_PATH ||
    entry.startsWith(`${SYNC_WORKFLOW_PATH}/`) ||
    entry === '.venfork' ||
    entry.startsWith('.venfork/')
  );
}

/**
 * Validates a single `preserve` entry. Rejects (returns null) anything that
 * isn't a clean repo-relative path: empty/whitespace-only, NUL bytes,
 * leading `/`, backslashes, Windows drive prefixes, leading `-`, glob
 * characters (`*`, `?`, `[`, `]`), a leading `:` (pathspec magic), or
 * `..` / `.` / empty segments, and venfork-owned paths
 * ({@link isVenforkOwnedPath}). Whitespace anywhere in the value is rejected
 * too — preserve paths surface verbatim in the divergence-error hint
 * (`venfork preserve add <path>`), so disallowing whitespace keeps that
 * copy/paste-safe without quoting and rules out an entire bug class for a
 * negligible cost (workflow/script paths conventionally don't use spaces).
 *
 * Leading `-` is forbidden so a preserved filename can't be parsed as a git
 * option (e.g. `git add --all`). Every internal call site already passes
 * paths after `--`, but rejecting up-front means an attacker-controlled or
 * accidentally-malformed entry can't reach those call sites at all.
 *
 * IMPORTANT: if you change the rejection rules below, also update:
 *   - the JSDoc on `VenforkConfig.preserve` (above)
 *   - the user-facing error message in `preserveCommand` (src/commands/preserve.ts)
 * All three must stay in sync — users see the JSDoc when editing config by
 * hand, and the error message when running `venfork preserve add`.
 */
export function normalizePreservePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\0')) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.startsWith('/')) return null;
  if (trimmed.startsWith('-')) return null;
  if (trimmed.includes('\\')) return null;
  if (/^[A-Za-z]:/.test(trimmed)) return null;
  if (trimmed.startsWith(':')) return null;
  if (/[*?[\]]/.test(trimmed)) return null;
  if (isVenforkOwnedPath(trimmed)) return null;
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

/** Options for {@link normalizeConfig}. */
export interface NormalizeOptions {
  /** Accept an invalid `schedule.cron`, for a write that replaces it. */
  allowInvalidCron?: boolean;
}

function configProblem(message: string): ConfigError {
  return new ConfigError(`Invalid ${CONFIG_BRANCH} config: ${message}`);
}

function normalizeConfig(
  input: unknown,
  options: NormalizeOptions = {}
): VenforkConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw configProblem(`${CONFIG_FILE} is not a JSON object`);
  }
  const config = input as VenforkConfig;
  if (!config.version || !config.upstreamUrl) {
    throw configProblem('version and upstreamUrl are required');
  }

  const mode: 'standard' | 'no-public' =
    config.mode === 'no-public' ? 'no-public' : 'standard';

  if (mode === 'standard' && !config.publicForkUrl) {
    throw configProblem('publicForkUrl is required unless mode is no-public');
  }
  if (mode === 'no-public' && config.publicForkUrl) {
    throw configProblem('mode no-public must not set publicForkUrl');
  }

  const normalized: VenforkConfig = {
    ...config,
  };
  delete normalized.invalidPreserve;
  if (mode === 'no-public') {
    normalized.mode = 'no-public';
    delete normalized.publicForkUrl;
  } else {
    delete normalized.mode;
  }

  if (normalized.schedule) {
    const cron =
      typeof normalized.schedule.cron === 'string'
        ? normalized.schedule.cron.trim()
        : '';
    if (!cron || typeof normalized.schedule.enabled !== 'boolean') {
      throw configProblem('schedule needs a cron string and enabled flag');
    }
    if (!options.allowInvalidCron && !isValidCronExpression(cron)) {
      throw configProblem(
        `schedule.cron '${cron}' is not a valid 5-field cron expression. Fix it with: venfork schedule set "<cron>" (or venfork schedule disable)`
      );
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

  if (normalized.preserve !== undefined) {
    const entries: unknown[] = Array.isArray(normalized.preserve)
      ? normalized.preserve
      : [normalized.preserve];
    const valid = new Set<string>();
    const invalid = new Set<string>();
    for (const entry of entries) {
      const cleaned = normalizePreservePath(entry);
      if (cleaned !== null) valid.add(cleaned);
      else
        invalid.add(typeof entry === 'string' ? entry : JSON.stringify(entry));
    }
    if (valid.size > 0) {
      normalized.preserve = [...valid].sort();
    } else {
      delete normalized.preserve;
    }
    if (invalid.size > 0) {
      normalized.invalidPreserve = [...invalid].sort();
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
 * The config as it is stored on the branch: invalid preserve entries are
 * kept in `preserve` so a save never silently drops them.
 */
function toPersisted(config: VenforkConfig): VenforkConfig {
  const { invalidPreserve, ...persisted } = config;
  if (invalidPreserve && invalidPreserve.length > 0) {
    persisted.preserve = [
      ...new Set([...(persisted.preserve ?? []), ...invalidPreserve]),
    ].sort();
  }
  return persisted;
}

/**
 * Throws a {@link ConfigError} when the config still holds preserve entries
 * that fail validation, naming each one and the command that removes it.
 * Sync and schedule call this before they rebuild the default branch.
 */
export function assertNoInvalidPreserve(config: VenforkConfig | null): void {
  const invalid = config?.invalidPreserve ?? [];
  if (invalid.length === 0) return;
  throw invalidPreserveError(invalid);
}

/**
 * The {@link ConfigError} for preserve entries venfork does not accept,
 * naming each one and the command that removes it.
 *
 * @param entries The rejected entries, as stored in the config.
 */
export function invalidPreserveError(entries: readonly string[]): ConfigError {
  return new ConfigError(
    `The preserve list has entries venfork no longer accepts (single files only; no globs, pathspec magic or directories):\n${entries
      .map((entry) => `  - ${entry}: ${preserveRemoveHint(entry)}`)
      .join(
        '\n'
      )}\nRemove each entry, then add the individual files you want to keep.`
  );
}

/**
 * The `venfork preserve remove` command for `entries`, each single-quoted
 * so a shell passes it through unchanged (`*.md` is not expanded).
 *
 * @param entries Preserve entries.
 */
export function preserveRemoveHint(...entries: string[]): string {
  const quoted = entries.map((entry) => `'${entry.replaceAll("'", "'\\''")}'`);
  return `venfork preserve remove ${quoted.join(' ')}`;
}

function parseConfig(
  raw: string,
  options: NormalizeOptions = {}
): VenforkConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `Invalid ${CONFIG_BRANCH} config: ${CONFIG_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
  return normalizeConfig(parsed, options);
}

/**
 * Fetches and reads the venfork config from a remote repository. Returns
 * null only when the repository has no `venfork-config` branch; any other
 * failure throws a {@link ConfigError}.
 */
export async function fetchVenforkConfig(
  repoUrl: string
): Promise<VenforkConfig | null> {
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-read-${uniqueId}`);

  try {
    const repoRef = parseRepoPath(repoUrl) || repoUrl;
    const clone = await netExec(undefined, {
      bufferOutput: true,
    })`gh repo clone ${repoRef} ${tempDir} -- --no-checkout --depth 1 --filter=blob:none`;
    if (clone.exitCode !== 0) {
      throw new ConfigError(
        `Could not clone ${repoRef} to read ${CONFIG_BRANCH}: ${netFailureReason(clone)}`,
        { reason: 'fetch' }
      );
    }
    const fetched = await fetchConfigContentAndSha(tempDir);
    return fetched ? parseConfig(fetched.raw) : null;
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
 * `FETCH_HEAD:<config>` (for the content) against that single fetch.
 * Returns null only when `git ls-remote --exit-code` reports that origin has
 * no `venfork-config` branch; every other failure throws a ConfigError.
 *
 * Capturing the SHA here is what lets `updateVenforkConfig` push back with
 * an explicit `--force-with-lease=<branch>:<sha>` against the *exact* SHA
 * we read from — the only lease that's safe under concurrent writers.
 */
async function fetchConfigContentAndSha(
  repoDir: string
): Promise<{ raw: string; sha: string } | null> {
  const probe = await netExec(repoDir, {
    bufferOutput: true,
  })`git ls-remote --exit-code origin refs/heads/${CONFIG_BRANCH}`;
  if (probe.exitCode === 2) {
    return null;
  }
  if (probe.exitCode !== 0) {
    throw new ConfigError(
      `Could not check origin for the ${CONFIG_BRANCH} branch: ${netFailureReason(probe)}`,
      { reason: 'fetch' }
    );
  }

  const fetchResult = await netExec(repoDir, {
    bufferOutput: true,
  })`git fetch origin ${CONFIG_BRANCH}`;
  if (fetchResult.exitCode !== 0) {
    throw new ConfigError(
      `Could not fetch ${CONFIG_BRANCH} from origin: ${netFailureReason(fetchResult)}`,
      { reason: 'fetch' }
    );
  }

  const revParseResult = await $({
    cwd: repoDir,
    reject: false,
  })`git rev-parse FETCH_HEAD`;
  const sha = revParseResult.exitCode === 0 ? revParseResult.stdout.trim() : '';
  if (!sha) {
    throw new ConfigError(
      `Could not resolve the fetched ${CONFIG_BRANCH} commit: ${revParseResult.stderr.trim()}`
    );
  }

  // A partial clone fetches this blob lazily, so it is a network read.
  const showResult = await netExec(repoDir, {
    bufferOutput: true,
  })`git show FETCH_HEAD:${CONFIG_DIR}/${CONFIG_FILE}`;
  if (showResult.exitCode !== 0) {
    throw new ConfigError(
      `${CONFIG_BRANCH} has no readable ${CONFIG_DIR}/${CONFIG_FILE}: ${netFailureReason(showResult)}`,
      showResult.timedOut ? { reason: 'fetch' } : undefined
    );
  }
  return { raw: showResult.stdout ?? '', sha };
}

/**
 * Reads venfork configuration from the local repo's orphan `venfork-config`
 * branch. Returns null only when origin has no such branch; a fetch,
 * parse or validation failure throws a {@link ConfigError}.
 */
export async function readVenforkConfigFromRepo(
  repoDir: string,
  options: NormalizeOptions = {}
): Promise<VenforkConfig | null> {
  const fetched = await fetchConfigContentAndSha(repoDir);
  return fetched ? parseConfig(fetched.raw, options) : null;
}

/**
 * Like `readVenforkConfigFromRepo` but also returns the SHA of the commit
 * the config was read from, so a later write can lease against it.
 */
export async function readVenforkConfigFromRepoWithSha(
  repoDir: string,
  options: NormalizeOptions = {}
): Promise<{ config: VenforkConfig; sha: string } | null> {
  const fetched = await fetchConfigContentAndSha(repoDir);
  if (!fetched) return null;
  return { config: parseConfig(fetched.raw, options), sha: fetched.sha };
}

/**
 * Apply a `VenforkConfigPatch` on top of an already-read config and return
 * the fully merged + normalized result, without writing it. The retry loop
 * in `updateVenforkConfig` re-applies the same patch to freshly-read state
 * after a `--force-with-lease` failure.
 *
 * @param current Config as read from the branch.
 * @param patch Shallow patch; `null` deletes a field or map entry.
 */
export function applyPatchAndNormalize(
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
    ...toPersisted(current),
    ...basePatch,
    schedule: basePatch.schedule
      ? {
          ...current.schedule,
          ...basePatch.schedule,
        }
      : current.schedule,
  };
  if (basePatch.schedule === null || merged.schedule === undefined) {
    delete merged.schedule;
  }

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

  return normalizeConfig(merged);
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
    const read = await readVenforkConfigFromRepoWithSha(repoDir, {
      allowInvalidCron: patch.schedule?.cron !== undefined,
    });
    if (!read) {
      throw new ConfigError(`${CONFIG_BRANCH} branch not found on origin`);
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
 * Writes `config` to `venfork-config` only if origin still has the commit
 * `expectedSha`, and returns the new commit's SHA. No retry: a moved branch
 * throws a `ConfigError` with reason `conflict` and nothing is written.
 */
export async function writeVenforkConfigAt(
  repoDir: string,
  config: VenforkConfig,
  expectedSha: string
): Promise<string> {
  try {
    return await writeConfigBranch(
      repoDir,
      config,
      UPDATE_CONFIG_COMMIT_MESSAGE,
      { expectedSha }
    );
  } catch (err) {
    if (isLeaseFailure(err)) {
      throw new ConfigError(
        `${CONFIG_BRANCH} changed on origin since this command read it; nothing was written. Re-run the command.`,
        { reason: 'conflict', cause: err }
      );
    }
    throw err;
  }
}

/**
 * Points `venfork-config` on origin back at the existing commit `sha`, only
 * if origin still has `expectedSha`. A moved branch throws a `ConfigError`
 * with reason `conflict`; any other failure throws a `GitError`.
 */
export async function restoreVenforkConfig(
  repoDir: string,
  sha: string,
  expectedSha: string
): Promise<void> {
  const push = await netExec(repoDir, {
    bufferOutput: true,
  })`git push origin ${sha}:refs/heads/${CONFIG_BRANCH} --force-with-lease=refs/heads/${CONFIG_BRANCH}:${expectedSha} --no-follow-tags`;
  if (push.exitCode === 0) return;
  const reason = netFailureReason(push);
  if (/stale info/i.test(reason)) {
    throw new ConfigError(
      `${CONFIG_BRANCH} changed on origin after ${expectedSha}`,
      { reason: 'conflict' }
    );
  }
  throw new GitError(`git push ${CONFIG_BRANCH} failed: ${reason}`, 'git push');
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

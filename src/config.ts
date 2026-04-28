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
  publicForkUrl: string;
  upstreamUrl: string;
  schedule?: {
    cron: string;
    enabled: boolean;
  };
  enabledWorkflows?: string[];
  disabledWorkflows?: string[];
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
  | 'shippedBranches'
  | 'pulledPrs'
  | 'shippedIssues'
  | 'pulledIssues'
> & {
  enabledWorkflows?: string[] | null;
  disabledWorkflows?: string[] | null;
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
 */
export async function createConfigBranch(
  repoDir: string,
  publicForkUrl: string,
  upstreamUrl: string
): Promise<void> {
  const config: VenforkConfig = {
    version: '1',
    publicForkUrl,
    upstreamUrl,
  };

  await writeConfigBranch(repoDir, config, 'Initialize venfork configuration');
}

async function writeConfigBranch(
  repoDir: string,
  config: VenforkConfig,
  commitMessage: string
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
    // Read the current SHA of the config branch (if it exists) so we can pass
    // an explicit lease — the bare `--force-with-lease` flag relies on a
    // remote-tracking ref, which doesn't exist in this fresh tempDir.
    // First-time writes have no upstream to lease against; falling back to a
    // plain push is safe (no concurrent writers can exist when the branch
    // doesn't yet exist).
    const lsRemote = await $({
      cwd: tempDir,
      reject: false,
    })`git ls-remote ${originUrl} ${CONFIG_BRANCH}`;
    const expectedSha =
      lsRemote.exitCode === 0
        ? (lsRemote.stdout.trim().split(/\s+/)[0] ?? '')
        : '';
    if (expectedSha) {
      await $({
        cwd: tempDir,
      })`git push ${originUrl} ${CONFIG_BRANCH}:${CONFIG_BRANCH} --force-with-lease=${CONFIG_BRANCH}:${expectedSha}`;
    } else {
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

function normalizePulledPr(value: unknown): PulledPr | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<PulledPr>;
  if (
    typeof v.upstreamPrNumber !== 'number' ||
    !Number.isFinite(v.upstreamPrNumber) ||
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
    typeof v.internalIssueNumber !== 'number' ||
    !Number.isFinite(v.internalIssueNumber) ||
    typeof v.internalIssueUrl !== 'string' ||
    !v.internalIssueUrl.trim() ||
    typeof v.upstreamIssueNumber !== 'number' ||
    !Number.isFinite(v.upstreamIssueNumber) ||
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
    typeof v.upstreamIssueNumber !== 'number' ||
    !Number.isFinite(v.upstreamIssueNumber) ||
    typeof v.upstreamIssueUrl !== 'string' ||
    !v.upstreamIssueUrl.trim() ||
    typeof v.internalIssueNumber !== 'number' ||
    !Number.isFinite(v.internalIssueNumber) ||
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
  if (!config.version || !config.publicForkUrl || !config.upstreamUrl) {
    return null;
  }

  const normalized: VenforkConfig = {
    ...config,
  };

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
 * Reads venfork configuration from the local repo's orphan `venfork-config` branch.
 */
export async function readVenforkConfigFromRepo(
  repoDir: string
): Promise<VenforkConfig | null> {
  const fetchResult = await $({
    cwd: repoDir,
    reject: false,
  })`git fetch origin ${CONFIG_BRANCH}`;
  if (fetchResult.exitCode !== 0) {
    return null;
  }

  const showResult = await $({
    cwd: repoDir,
    reject: false,
  })`git show FETCH_HEAD:${CONFIG_DIR}/${CONFIG_FILE}`;
  if (showResult.exitCode !== 0) {
    return null;
  }

  try {
    const config = JSON.parse(showResult.stdout) as VenforkConfig;
    return normalizeConfig(config);
  } catch {
    return null;
  }
}

/**
 * Updates and force-pushes `venfork-config` with a shallow merge patch.
 */
export async function updateVenforkConfig(
  repoDir: string,
  patch: VenforkConfigPatch
): Promise<VenforkConfig> {
  const current = await readVenforkConfigFromRepo(repoDir);
  if (!current) {
    throw new Error('venfork-config branch not found or invalid');
  }

  const {
    enabledWorkflows: _enabledWorkflowsPatch,
    disabledWorkflows: _disabledWorkflowsPatch,
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

  await writeConfigBranch(repoDir, normalized, UPDATE_CONFIG_COMMIT_MESSAGE);
  return normalized;
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

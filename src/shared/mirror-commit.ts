import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  assertNoInvalidPreserve,
  preserveRemoveHint,
  type VenforkConfig,
} from '../config.js';
import { GitError, VenforkError } from '../errors.js';
import { VENFORK_VERSION } from '../version.js';
import { generateSyncWorkflow } from '../workflow.js';
import {
  SYNC_WORKFLOW_PATH,
  VENFORK_BOT_EMAIL,
  VENFORK_BOT_NAME,
  WORKFLOWS_DIR,
} from './constants.js';
import {
  MANAGED_COMMIT_MESSAGE,
  MANAGED_COMMIT_TRAILER,
} from './managed-commit.js';
import { netExec, netFailureReason } from './net.js';
import { compareSemver, pinnedVenforkVersion } from './semver.js';

/** True for a `*.yml` / `*.yaml` file directly in `.github/workflows/`. */
function isTopLevelWorkflow(file: string): boolean {
  return path.posix.dirname(file) === WORKFLOWS_DIR && /\.ya?ml$/.test(file);
}

/** Basenames of `entries`, trimmed, de-duplicated and sorted. */
export function normalizeWorkflowList(entries: string[]): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => path.basename(entry.trim()))
        .filter((entry) => entry.length > 0)
        .sort()
    )
  );
}

/** One entry of `git ls-tree -z` output. */
interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

function parseLsTree(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const match = record.match(/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/);
    if (match) {
      entries.push({
        mode: match[1],
        type: match[2],
        oid: match[3],
        path: match[4],
      });
    }
  }
  return entries;
}

/** Runs git against the repo with a private index file and no hooks. */
type PlumbingGit = (
  args: string[],
  options?: { input?: string; env?: Record<string, string> }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Runs `fn` with a git runner bound to `repoDir`, a fresh temporary index
 * (`GIT_INDEX_FILE`) and an empty hooks directory. Inherited `GIT_DIR`,
 * `GIT_WORK_TREE` and `GIT_INDEX_FILE` are dropped, so the user's index,
 * worktree, sparse-checkout and hooks never take part.
 */
async function withTempIndex<T>(
  repoDir: string,
  fn: (git: PlumbingGit) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-index-'));
  const hooksDir = path.join(tempDir, 'hooks');
  await mkdir(hooksDir);
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'GIT_DIR' || key === 'GIT_WORK_TREE') continue;
    if (key === 'GIT_INDEX_FILE') continue;
    baseEnv[key] = value;
  }
  baseEnv.GIT_INDEX_FILE = path.join(tempDir, 'index');
  const git: PlumbingGit = async (args, options = {}) => {
    const result = await $({
      cwd: repoDir,
      env: { ...baseEnv, ...options.env },
      extendEnv: false,
      reject: false,
      stripFinalNewline: false,
      ...(options.input === undefined ? {} : { input: options.input }),
    })`git -c core.hooksPath=${hooksDir} --literal-pathspecs ${args}`;
    return {
      exitCode: result.exitCode ?? 1,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  };
  try {
    return await fn(git);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Runs a plumbing command and throws a GitError with stderr on failure. */
async function mustGit(
  git: PlumbingGit,
  args: string[],
  options?: { input?: string; env?: Record<string, string> }
): Promise<string> {
  const result = await git(args, options);
  if (result.exitCode !== 0) {
    throw new GitError(
      `git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      `git ${args[0]}`
    );
  }
  return result.stdout;
}

/** Entries of `ref`'s tree at exactly `entryPath` (not below it). */
async function treeEntriesAt(
  git: PlumbingGit,
  ref: string,
  entryPath: string
): Promise<TreeEntry[]> {
  const out = await mustGit(git, ['ls-tree', '-z', ref, '--', entryPath]);
  return parseLsTree(out).filter((entry) => entry.path === entryPath);
}

/**
 * Builds the commit that `origin/<defaultBranch>` should point at: the
 * upstream tip plus at most one venfork-managed commit. Nothing is pushed.
 *
 * The tree is assembled with plumbing on a temporary index read from the
 * upstream tip: no worktree, no filesystem checks, no hooks and no
 * filters. The managed commit holds the sync workflow (when `schedule` is
 * set), the workflow allow/block filtering by exact basename, and
 * preserved mirror-only files copied as blobs from `previousMirrorTip`
 * unless upstream's tree already has the path. Its author, committer and
 * dates come from fixed inputs (bot identity, upstream tip's committer
 * date), so the same inputs always give the same SHA. When the resulting
 * tree equals the upstream tree, the upstream tip is returned.
 *
 * Pass an empty `previousMirrorTip` when origin has no default branch yet;
 * `preserve` must be empty in that case.
 */
export async function buildMirrorTip(args: {
  defaultBranch: string;
  upstreamTip: string;
  schedule: { cron: string; mode: 'standard' | 'no-public' } | null;
  enabledWorkflows: string[];
  disabledWorkflows: string[];
  preserve: string[];
  previousMirrorTip: string;
  cwd?: string;
}): Promise<string> {
  const {
    defaultBranch,
    upstreamTip,
    schedule,
    enabledWorkflows,
    disabledWorkflows,
    preserve,
    previousMirrorTip,
    cwd,
  } = args;
  const repoDir = cwd ?? process.cwd();
  const allowlist = normalizeWorkflowList(enabledWorkflows);
  const blocklist = normalizeWorkflowList(disabledWorkflows);

  return withTempIndex(repoDir, async (git) => {
    await mustGit(git, ['read-tree', upstreamTip]);

    if (schedule) {
      const blob = (
        await mustGit(git, ['hash-object', '-w', '--no-filters', '--stdin'], {
          input: generateSyncWorkflow(schedule.cron, schedule.mode),
        })
      ).trim();
      await mustGit(git, [
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${blob},${SYNC_WORKFLOW_PATH}`,
      ]);

      // Precedence: enabledWorkflows allowlist > disabledWorkflows blocklist.
      if (allowlist.length > 0 || blocklist.length > 0) {
        const listed = await mustGit(git, [
          'ls-tree',
          '-r',
          '-z',
          '--name-only',
          upstreamTip,
          '--',
          WORKFLOWS_DIR,
        ]);
        for (const workflowFile of listed.split('\0').filter(Boolean)) {
          if (workflowFile === SYNC_WORKFLOW_PATH) continue;
          if (!isTopLevelWorkflow(workflowFile)) continue;
          const base = path.posix.basename(workflowFile);
          const keep =
            allowlist.length > 0
              ? allowlist.includes(base)
              : !blocklist.includes(base);
          if (!keep) {
            await mustGit(git, [
              'update-index',
              '--force-remove',
              '--',
              workflowFile,
            ]);
          }
        }
      }
    }

    if (preserve.length > 0) {
      if (!previousMirrorTip) {
        throw new Error(
          `Cannot preserve files: no previous origin/${defaultBranch} tip to read from.\n` +
            'Run `venfork sync` once to populate the mirror, then commit your preserved files and re-run sync.'
        );
      }
      for (const preservePath of preserve) {
        if (
          preservePath === SYNC_WORKFLOW_PATH ||
          preservePath === '.venfork' ||
          preservePath.startsWith('.venfork/')
        ) {
          continue;
        }
        const upstreamEntries = await treeEntriesAt(
          git,
          upstreamTip,
          preservePath
        );
        if (upstreamEntries.some((entry) => entry.type === 'tree')) {
          throw new Error(
            `Preserved file '${preservePath}' cannot be restored: upstream now has a directory at '${preservePath}'.\n` +
              `Move the preserved file elsewhere, or remove the entry with:\n  ${preserveRemoveHint(preservePath)}`
          );
        }
        if (upstreamEntries.length > 0) {
          p.log.warn(
            `preserved file '${preservePath}' now exists upstream — using upstream version`
          );
          continue;
        }
        const entry = await preservedEntry({
          git,
          upstreamTip,
          sourceTip: previousMirrorTip,
          preservePath,
          defaultBranch,
        });
        await mustGit(git, [
          'update-index',
          '--add',
          '--cacheinfo',
          `${entry.mode},${entry.oid},${preservePath}`,
        ]);
      }
    }

    const tree = (await mustGit(git, ['write-tree'])).trim();
    const upstreamTree = (
      await mustGit(git, ['rev-parse', `${upstreamTip}^{tree}`])
    ).trim();
    if (tree === upstreamTree) {
      return upstreamTip;
    }

    const upstreamDate = (
      await mustGit(git, [
        'show',
        '-s',
        '--format=%cd',
        '--date=raw',
        upstreamTip,
      ])
    ).trim();
    const commit = await mustGit(
      git,
      [
        '-c',
        'i18n.commitEncoding=UTF-8',
        'commit-tree',
        '--no-gpg-sign',
        tree,
        '-p',
        upstreamTip,
        '-m',
        MANAGED_COMMIT_MESSAGE,
        '-m',
        MANAGED_COMMIT_TRAILER,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: VENFORK_BOT_NAME,
          GIT_AUTHOR_EMAIL: VENFORK_BOT_EMAIL,
          GIT_AUTHOR_DATE: upstreamDate,
          GIT_COMMITTER_NAME: VENFORK_BOT_NAME,
          GIT_COMMITTER_EMAIL: VENFORK_BOT_EMAIL,
          GIT_COMMITTER_DATE: upstreamDate,
        },
      }
    );
    return commit.trim();
  });
}

/**
 * The tree entry to restore for `preservePath` from `sourceTip`. The path
 * must be a single file (regular, executable or symlink) there, and every
 * parent directory must be a directory or absent in the upstream tree.
 */
async function preservedEntry(args: {
  git: PlumbingGit;
  upstreamTip: string;
  sourceTip: string;
  preservePath: string;
  defaultBranch: string;
}): Promise<TreeEntry> {
  const { git, upstreamTip, sourceTip, preservePath, defaultBranch } = args;
  const segments = preservePath.split('/');
  for (let i = 1; i < segments.length; i++) {
    const ancestor = segments.slice(0, i).join('/');
    const found = await treeEntriesAt(git, upstreamTip, ancestor);
    if (found.some((entry) => entry.type !== 'tree')) {
      throw new Error(
        `Preserved file '${preservePath}' cannot be restored: upstream now has a file at '${ancestor}'.\n` +
          `Move the preserved file elsewhere, or remove the entry with:\n  ${preserveRemoveHint(preservePath)}`
      );
    }
    const staged = await mustGit(git, ['ls-files', '-z', '--', ancestor]);
    if (staged.split('\0').includes(ancestor)) {
      throw new Error(
        `Preserved file '${preservePath}' cannot be restored: a file exists at '${ancestor}' in the managed tree.\n` +
          `Move the preserved file elsewhere, or remove the entry with:\n  ${preserveRemoveHint(preservePath)}`
      );
    }
  }

  const entries = await treeEntriesAt(git, sourceTip, preservePath);
  const [entry] = entries;
  if (!entry || entries.length !== 1) {
    throw new Error(
      `Preserved file '${preservePath}' not found on origin/${defaultBranch}.\n` +
        'Either commit it to the mirror first, or remove the entry with:\n' +
        `  ${preserveRemoveHint(preservePath)}`
    );
  }
  if (entry.type === 'tree') {
    throw new Error(
      `Preserved path '${preservePath}' is a directory on origin/${defaultBranch}; preserve supports single files only. List each file instead.`
    );
  }
  if (
    entry.type !== 'blob' ||
    !['100644', '100755', '120000'].includes(entry.mode)
  ) {
    throw new Error(
      `Preserved path '${preservePath}' is not a regular file, executable or symlink on origin/${defaultBranch} (mode ${entry.mode}); preserve supports single files only.`
    );
  }
  return entry;
}

/**
 * Points `<remote>/<branch>` at `target` with an explicit lease on
 * `expected` (empty means the branch must not exist yet). Skips the push and
 * returns false when the remote already points at `target`. Throws a
 * `GitError` that says to re-run sync when the lease is stale.
 */
export async function pushBranchWithLease(args: {
  remote: string;
  branch: string;
  target: string;
  expected: string;
  cwd?: string;
}): Promise<boolean> {
  const { remote, branch, target, expected, cwd } = args;
  if (target === expected) {
    return false;
  }
  const result = await netExec(cwd, {
    bufferOutput: true,
  })`git push ${remote} ${target}:refs/heads/${branch} --force-with-lease=refs/heads/${branch}:${expected} --no-follow-tags`;
  if (result.exitCode !== 0) {
    const reason = netFailureReason(result);
    throw new GitError(
      /stale info/i.test(reason)
        ? `${remote}/${branch} moved since this sync fetched it. Re-run \`venfork sync\` to pick up the new commits.`
        : `push to ${remote}/${branch} failed: ${reason}`,
      `git push ${remote} ${branch}`
    );
  }
  return true;
}

/** Full SHA of `ref` as a commit, or an empty string when it does not resolve. */
export async function resolveCommit(
  ref: string,
  cwd?: string
): Promise<string> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git rev-parse --verify ${`${ref}^{commit}`}`;
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

/**
 * The commit `origin/<defaultBranch>` should point at for `config`: the
 * upstream tip plus the managed commit when a schedule or preserve list is
 * active, else the plain upstream tip. Refuses to downgrade a newer pinned
 * workflow. Nothing is pushed.
 */
export async function buildOriginTip(args: {
  config: VenforkConfig | null;
  defaultBranch: string;
  upstreamTip: string;
  previousMirrorTip: string;
  cwd?: string;
}): Promise<string> {
  const { config, defaultBranch, upstreamTip, previousMirrorTip, cwd } = args;
  assertNoInvalidPreserve(config);
  const schedule = config?.schedule;
  const scheduleActive = Boolean(schedule?.enabled && schedule.cron);
  if (scheduleActive && previousMirrorTip) {
    await assertNoPinDowngrade(previousMirrorTip, cwd);
  }
  const preserve = config?.preserve ?? [];
  if (!scheduleActive && preserve.length === 0) {
    return upstreamTip;
  }
  return buildMirrorTip({
    defaultBranch,
    upstreamTip,
    schedule:
      scheduleActive && schedule
        ? {
            cron: schedule.cron,
            mode: config?.mode === 'no-public' ? 'no-public' : 'standard',
          }
        : null,
    enabledWorkflows: config?.enabledWorkflows ?? [],
    disabledWorkflows: config?.disabledWorkflows ?? [],
    preserve,
    previousMirrorTip,
    cwd,
  });
}

/**
 * Moves `origin/<defaultBranch>` to {@link buildOriginTip}'s commit with
 * one leased push at most.
 */
export async function updateOriginTip(args: {
  config: VenforkConfig | null;
  defaultBranch: string;
  upstreamTip: string;
  previousMirrorTip: string;
  cwd?: string;
}): Promise<{ tip: string; pushed: boolean }> {
  const tip = await buildOriginTip(args);
  const pushed = await pushBranchWithLease({
    remote: 'origin',
    branch: args.defaultBranch,
    target: tip,
    expected: args.previousMirrorTip,
    cwd: args.cwd,
  });
  return { tip, pushed };
}

/**
 * Throws when the sync workflow on `mirrorTip` pins a newer venfork than the
 * running CLI, so an older CLI never rewrites a newer pin (local and runner
 * syncs would otherwise keep rewriting each other's managed commit).
 */
export async function assertNoPinDowngrade(
  mirrorTip: string,
  cwd?: string
): Promise<void> {
  const shown = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git show ${`${mirrorTip}:${SYNC_WORKFLOW_PATH}`}`;
  if (shown.exitCode !== 0) return;
  const pinned = pinnedVenforkVersion(shown.stdout);
  if (pinned && (compareSemver(pinned, VENFORK_VERSION) ?? 0) > 0) {
    throw new VenforkError(
      `origin pins venfork ${pinned}, you are running ${VENFORK_VERSION}; upgrade the CLI or set VENFORK_INSTALL_SPEC`
    );
  }
}

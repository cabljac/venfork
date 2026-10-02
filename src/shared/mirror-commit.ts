import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { $ } from 'execa';
import { generateSyncWorkflow } from '../workflow.js';
import {
  SYNC_WORKFLOW_PATH,
  VENFORK_BOT_EMAIL,
  VENFORK_BOT_NAME,
  WORKFLOWS_DIR,
} from './constants.js';
import { pathExists } from './fs.js';
import {
  MANAGED_COMMIT_MESSAGE,
  MANAGED_COMMIT_TRAILER,
} from './managed-commit.js';
import { withDetachedWorktree } from './worktree.js';

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

async function listWorkflowFiles(cwd: string): Promise<string[]> {
  const result = await $({
    cwd,
    reject: false,
  })`git ls-tree -r --name-only HEAD -- ${WORKFLOWS_DIR}`;
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Builds the commit that `origin/<defaultBranch>` should point at: the
 * upstream tip plus at most one venfork-managed commit. Nothing is pushed.
 *
 * The managed commit holds the sync workflow (when `schedule` is set), the
 * workflow allow/block filtering, and preserved mirror-only files read from
 * `previousMirrorTip`. Its author, committer and dates come from fixed
 * inputs (bot identity, upstream tip's committer date), so the same upstream
 * tip and the same tree always give the same SHA. When the resulting tree
 * equals the upstream tree, no commit is made and the upstream tip is
 * returned.
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

  return withDetachedWorktree(
    repoDir,
    upstreamTip,
    'venfork-sync-',
    async (tempDir) => {
      if (schedule) {
        await mkdir(path.join(tempDir, '.github', 'workflows'), {
          recursive: true,
        });
        await writeFile(
          path.join(tempDir, SYNC_WORKFLOW_PATH),
          generateSyncWorkflow(schedule.cron, schedule.mode)
        );
        await $({ cwd: tempDir })`git add -- ${SYNC_WORKFLOW_PATH}`;

        // Filter upstream workflow files as part of the managed "+1" commit.
        // Precedence: enabledWorkflows allowlist > disabledWorkflows blocklist.
        if (allowlist.length > 0 || blocklist.length > 0) {
          const workflowFiles = await listWorkflowFiles(tempDir);
          for (const workflowFile of workflowFiles) {
            if (workflowFile === SYNC_WORKFLOW_PATH) {
              continue;
            }
            const base = path.basename(workflowFile);
            const shouldKeep =
              allowlist.length > 0
                ? allowlist.includes(base)
                : !blocklist.includes(base);
            if (!shouldKeep) {
              await $({
                cwd: tempDir,
                reject: false,
              })`git rm --quiet --ignore-unmatch -- ${workflowFile}`;
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
          const upstreamHasIt = await pathExists(
            path.join(tempDir, preservePath)
          );
          if (upstreamHasIt) {
            p.log.warn(
              `preserved file '${preservePath}' now exists upstream — using upstream version`
            );
            continue;
          }
          await addPreservedFile({
            worktreeDir: tempDir,
            sourceTip: previousMirrorTip,
            preservePath,
            defaultBranch,
          });
        }
      }

      const tree = (await $({ cwd: tempDir })`git write-tree`).stdout.trim();
      const upstreamTree = (
        await $({ cwd: tempDir })`git rev-parse ${`${upstreamTip}^{tree}`}`
      ).stdout.trim();
      if (tree === upstreamTree) {
        return upstreamTip;
      }

      const upstreamDate = (
        await $({
          cwd: tempDir,
        })`git show -s --format=%cd --date=raw ${upstreamTip}`
      ).stdout.trim();
      const commit = await $({
        cwd: tempDir,
        env: {
          GIT_AUTHOR_NAME: VENFORK_BOT_NAME,
          GIT_AUTHOR_EMAIL: VENFORK_BOT_EMAIL,
          GIT_AUTHOR_DATE: upstreamDate,
          GIT_COMMITTER_NAME: VENFORK_BOT_NAME,
          GIT_COMMITTER_EMAIL: VENFORK_BOT_EMAIL,
          GIT_COMMITTER_DATE: upstreamDate,
        },
      })`git commit-tree --no-gpg-sign ${tree} -p ${upstreamTip} -m ${MANAGED_COMMIT_MESSAGE} -m ${MANAGED_COMMIT_TRAILER}`;
      return commit.stdout.trim();
    }
  );
}

/**
 * Points `<remote>/<branch>` at `target` with an explicit lease on
 * `expected` (empty means the branch must not exist yet). Skips the push and
 * returns false when the remote already points at `target`.
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
  await $({
    ...(cwd ? { cwd } : {}),
  })`git push ${remote} ${target}:refs/heads/${branch} --force-with-lease=refs/heads/${branch}:${expected}`;
  return true;
}

/**
 * Re-stamps `origin/<defaultBranch>` as the upstream tip plus at most one
 * deterministic venfork-managed commit (see {@link buildMirrorTip}) with a
 * single leased push. Returns the new tip and whether a push happened.
 */
export async function applyMirrorPlusOneCommit(
  args: Parameters<typeof buildMirrorTip>[0]
): Promise<{ tip: string; pushed: boolean }> {
  const tip = await buildMirrorTip(args);
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
 * Writes (or removes, when `workflowContent` is null) the managed sync
 * workflow on `origin/<defaultBranch>` as a managed commit. Returns false when
 * nothing changed.
 */
export async function updateWorkflowOnOriginDefault(
  defaultBranch: string,
  workflowContent: string | null,
  cwd?: string
): Promise<boolean> {
  const repoDir = cwd ?? process.cwd();
  return withDetachedWorktree(
    repoDir,
    `origin/${defaultBranch}`,
    'venfork-workflow-',
    async (tempDir) => {
      if (workflowContent === null) {
        await $({
          cwd: tempDir,
          reject: false,
        })`git rm --quiet --ignore-unmatch -- ${SYNC_WORKFLOW_PATH}`;
      } else {
        await mkdir(path.join(tempDir, '.github', 'workflows'), {
          recursive: true,
        });
        await writeFile(
          path.join(tempDir, SYNC_WORKFLOW_PATH),
          workflowContent
        );
        await $({ cwd: tempDir })`git add -- ${SYNC_WORKFLOW_PATH}`;
      }

      const stagedDiff = await $({
        cwd: tempDir,
        reject: false,
      })`git diff --cached --quiet`;
      if (stagedDiff.exitCode === 0) {
        return false;
      }

      await $({
        cwd: tempDir,
      })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit -m ${MANAGED_COMMIT_MESSAGE} -m ${MANAGED_COMMIT_TRAILER}`;
      await $({
        cwd: tempDir,
      })`git push origin HEAD:${defaultBranch} --force-with-lease`;
      return true;
    }
  );
}

/**
 * Stages `preservePath` from `sourceTip` into the worktree at `worktreeDir`.
 * The path is matched literally and must be a single file (regular,
 * executable or symlink) on `sourceTip`. Throws, without touching the
 * worktree, when the path is missing, is a directory or submodule, or when
 * one of its parent directories is a file in the worktree.
 */
export async function addPreservedFile(args: {
  worktreeDir: string;
  sourceTip: string;
  preservePath: string;
  defaultBranch: string;
}): Promise<void> {
  const { worktreeDir, sourceTip, preservePath, defaultBranch } = args;
  const lsTree = async (ref: string, entry: string): Promise<string> =>
    (
      await $({
        cwd: worktreeDir,
        reject: false,
      })`git --literal-pathspecs ls-tree ${ref} -- ${entry}`
    ).stdout.trim();

  const segments = preservePath.split('/');
  for (let i = 1; i < segments.length; i++) {
    const ancestor = segments.slice(0, i).join('/');
    const entry = await lsTree('HEAD', ancestor);
    if (/^\d+ blob /.test(entry)) {
      throw new Error(
        `Preserved file '${preservePath}' cannot be restored: upstream now has a file at '${ancestor}'.\n` +
          `Move the preserved file elsewhere, or remove the entry with:\n  venfork preserve remove ${preservePath}`
      );
    }
  }

  const entries = (await lsTree(sourceTip, preservePath))
    .split('\n')
    .filter(Boolean);
  const match = entries[0]?.match(/^(\d+) (\w+) [0-9a-f]+\t(.*)$/);
  if (!match || entries.length !== 1 || match[3] !== preservePath) {
    throw new Error(
      `Preserved file '${preservePath}' not found on origin/${defaultBranch}.\n` +
        'Either commit it to the mirror first, or remove the entry with:\n' +
        `  venfork preserve remove ${preservePath}`
    );
  }
  const [, mode, type] = match;
  if (type === 'tree') {
    throw new Error(
      `Preserved path '${preservePath}' is a directory on origin/${defaultBranch}; preserve supports single files only. List each file instead.`
    );
  }
  if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) {
    throw new Error(
      `Preserved path '${preservePath}' is not a regular file, executable or symlink on origin/${defaultBranch} (mode ${mode}); preserve supports single files only.`
    );
  }

  const checkout = await $({
    cwd: worktreeDir,
    reject: false,
  })`git --literal-pathspecs checkout ${sourceTip} -- ${preservePath}`;
  if (checkout.exitCode !== 0) {
    throw new Error(
      `Could not restore preserved file '${preservePath}' from origin/${defaultBranch}: ${checkout.stderr.trim() || `exit ${checkout.exitCode}`}`
    );
  }
}

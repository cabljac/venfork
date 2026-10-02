import { chmod, mkdir, writeFile } from 'node:fs/promises';
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
import { MANAGED_COMMIT_MESSAGE } from './managed-commit.js';
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
 * Re-stamp `origin/<defaultBranch>` as `upstream/<defaultBranch>` plus one
 * deterministic "+1 commit" containing the managed sync workflow (when
 * scheduled) and any preserved mirror-only files. Force-pushes the result.
 *
 * `previousMirrorTip` is the commit-ish to read preserve sources from
 * (typically captured from `git rev-parse origin/<defaultBranch>` *before*
 * sync's force-push runs). Pass an empty string when no previous tip exists
 * (first sync); preserve must be empty in that case.
 */
export async function applyMirrorPlusOneCommit(args: {
  defaultBranch: string;
  schedule: { cron: string; mode: 'standard' | 'no-public' } | null;
  enabledWorkflows: string[];
  disabledWorkflows: string[];
  preserve: string[];
  previousMirrorTip: string;
  cwd?: string;
}): Promise<void> {
  const {
    defaultBranch,
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

  // Re-stamp from upstream so the private mirror default branch is always
  // `upstream + exactly one deterministic internal workflow commit`.
  await withDetachedWorktree(
    repoDir,
    `upstream/${defaultBranch}`,
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
          const showResult = await $({
            cwd: repoDir,
            reject: false,
            encoding: 'buffer',
            stripFinalNewline: false,
          })`git show ${previousMirrorTip}:${preservePath}`;
          if (showResult.exitCode !== 0) {
            throw new Error(
              `Preserved file '${preservePath}' not found on origin/${defaultBranch}.\n` +
                'Either commit it to the mirror first, or remove the entry with:\n' +
                `  venfork preserve remove ${preservePath}`
            );
          }
          // Preserve the executable bit by reading the tree entry's mode.
          // `git show <ref>:<path>` only emits content; mode lives on the tree.
          // Symlinks (120000) and submodules (160000) are out of scope — those
          // would need plumbing-level handling. Plain files and `+x` files cover
          // the realistic mirror-only cases (caller workflows, release scripts).
          const lsTreeResult = await $({
            cwd: repoDir,
            reject: false,
          })`git ls-tree ${previousMirrorTip} -- ${preservePath}`;
          const treeMode = lsTreeResult.stdout.match(/^(\d+) /)?.[1];
          const targetPath = path.join(tempDir, preservePath);
          await mkdir(path.dirname(targetPath), { recursive: true });
          await writeFile(targetPath, showResult.stdout);
          if (treeMode === '100755') {
            await chmod(targetPath, 0o755);
          }
          await $({ cwd: tempDir })`git add -- ${preservePath}`;
        }
      }

      await $({
        cwd: tempDir,
      })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit --allow-empty -m ${MANAGED_COMMIT_MESSAGE}`;

      await $({
        cwd: tempDir,
      })`git push origin HEAD:${defaultBranch} --force-with-lease`;
    }
  );
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
      })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit -m ${MANAGED_COMMIT_MESSAGE}`;
      await $({
        cwd: tempDir,
      })`git push origin HEAD:${defaultBranch} --force-with-lease`;
      return true;
    }
  );
}

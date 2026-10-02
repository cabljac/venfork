import { $ } from 'execa';
import { SYNC_WORKFLOW_PATH, WORKFLOWS_DIR } from './constants.js';

/**
 * Subject line emitted on every venfork-managed "+1 commit" — both the
 * scheduled-workflow case and the preserve-only case. Generalized from the
 * original "scheduled sync workflow" wording because the same commit can now
 * carry preserve content with no workflow involvement; an honest subject
 * keeps `git log` readable and lets `isManagedCommit` rely on a single
 * canonical match without misclassifying preserve-only commits.
 */
export const MANAGED_COMMIT_MESSAGE = 'chore: venfork-managed mirror commit';
/**
 * Subjects emitted by older venfork versions for the same "+1 commit" role.
 * Recognized by `isManagedCommit` so existing mirrors don't suddenly classify
 * historical managed commits as user-authored divergence after upgrading.
 */
export const LEGACY_MANAGED_COMMIT_MESSAGES: readonly string[] = [
  'chore: add/update scheduled sync workflow (venfork)',
];

async function commitSubject(
  ref: string,
  cwd?: string
): Promise<string | null> {
  const cwdOpt = cwd ? { cwd } : {};
  const result = await $({
    ...cwdOpt,
    reject: false,
  })`git log -1 --format=%s ${ref}`;
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function commitTouchesWorkflowPath(
  ref: string,
  cwd?: string
): Promise<boolean> {
  const cwdOpt = cwd ? { cwd } : {};
  const filesResult = await $({
    ...cwdOpt,
    reject: false,
  })`git show --name-only --pretty=format: ${ref}`;
  if (filesResult.exitCode !== 0) {
    return false;
  }
  // Same line-handling rule as `changedFilesInCommit`: only strip a
  // trailing CR (CRLF on Windows checkouts), not arbitrary whitespace.
  const changedFiles = filesResult.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');
  if (!changedFiles.length) {
    return false;
  }
  // A commit is the venfork-managed "+1" only when it (a) touches the managed
  // workflow file and (b) doesn't reach outside `.github/workflows/`. Without
  // (a), legitimate user commits to other workflows (e.g. ci.yml) would be
  // silently dropped during stage. Without (b), arbitrary user commits could
  // be misclassified as managed.
  const allUnderWorkflows = changedFiles.every((filePath) =>
    filePath.startsWith(`${WORKFLOWS_DIR}/`)
  );
  const touchesManagedWorkflow = changedFiles.includes(SYNC_WORKFLOW_PATH);
  return allUnderWorkflows && touchesManagedWorkflow;
}

/**
 * Detects the venfork-managed "+1 commit" so sync's divergence check and
 * stage's cherry-pick filter can skip it without losing user work.
 *
 * Three signals all classify a commit as managed:
 *  1. Subject matches the current `MANAGED_COMMIT_MESSAGE`.
 *  2. Subject matches one of `LEGACY_MANAGED_COMMIT_MESSAGES` — covers
 *     mirrors created before the message was generalized.
 *  3. Path heuristic: commit touches the managed `venfork-sync.yml` and
 *     reaches no further than `.github/workflows/`. This rescues historical
 *     rollouts that bundled extra workflow files alongside the managed one,
 *     while keeping user-authored commits to *other* workflow files (e.g.
 *     ci.yml) classified as user content.
 */
export async function isManagedCommit(
  ref: string,
  cwd?: string
): Promise<boolean> {
  const subject = await commitSubject(ref, cwd);
  if (subject !== null) {
    if (subject === MANAGED_COMMIT_MESSAGE) return true;
    if (LEGACY_MANAGED_COMMIT_MESSAGES.includes(subject)) return true;
  }
  return commitTouchesWorkflowPath(ref, cwd);
}

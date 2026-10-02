import { $ } from 'execa';
import {
  SYNC_WORKFLOW_PATH,
  VENFORK_BOT_EMAIL,
  WORKFLOWS_DIR,
} from './constants.js';

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
/** Trailer key written on every venfork-managed commit. */
export const MANAGED_COMMIT_TRAILER_KEY = 'Venfork-Managed';
/** Full trailer line written on every venfork-managed commit. */
export const MANAGED_COMMIT_TRAILER = `${MANAGED_COMMIT_TRAILER_KEY}: 1`;

/**
 * True when `ref` carries the `Venfork-Managed: 1` trailer, whatever it
 * changes. Use {@link classifyManagedCommit} to decide whether sync may
 * replace it.
 */
export async function hasManagedTrailer(
  ref: string,
  cwd?: string
): Promise<boolean> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git log -1 --format=%(trailers:key=${MANAGED_COMMIT_TRAILER_KEY},valueonly) ${ref}`;
  return result.exitCode === 0 && result.stdout.trim() === '1';
}

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
  })`git show -z --name-only --pretty=format: ${ref}`;
  if (filesResult.exitCode !== 0) {
    return false;
  }
  const changedFiles = filesResult.stdout
    .split('\0')
    .filter((entry) => entry !== '');
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
 * True when every change `ref` makes against its first parent is one the
 * managed commit may carry: the sync workflow, a `preserve` entry, or a
 * deletion under `.github/workflows/` (workflow filtering).
 */
async function onlyManagedContent(
  ref: string,
  cwd: string | undefined,
  preserve: ReadonlySet<string>
): Promise<boolean> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git diff-tree -r -z --no-renames --root --no-commit-id --name-status ${ref}`;
  if (result.exitCode !== 0) return false;
  const fields = result.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? '';
    const file = fields[i + 1] ?? '';
    if (!status) continue;
    if (file === SYNC_WORKFLOW_PATH || preserve.has(file)) continue;
    if (status === 'D' && file.startsWith(`${WORKFLOWS_DIR}/`)) continue;
    return false;
  }
  return true;
}

/** Which signal classified a commit as venfork-managed. */
export type ManagedCommitKind =
  | 'trailer'
  | 'subject'
  | 'legacy-subject'
  | 'path-heuristic';

async function authorEmail(ref: string, cwd?: string): Promise<string | null> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git log -1 --format=%ae ${ref}`;
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Classifies the venfork-managed "+1 commit" so sync's divergence check and
 * stage's cherry-pick filter can skip it without losing user work. Returns
 * the first matching signal, or null for a user commit:
 *  - `trailer`: a `Venfork-Managed: 1` trailer on a commit that changes
 *    only the sync workflow, `preserve` entries, and deletions under
 *    `.github/workflows/`. A trailer commit that changes anything else
 *    (user work amended into it) is null.
 *  - `subject`: subject equals `MANAGED_COMMIT_MESSAGE`.
 *  - `legacy-subject`: subject is in `LEGACY_MANAGED_COMMIT_MESSAGES`.
 *  - `path-heuristic`: authored by the venfork bot, touches the managed
 *    `venfork-sync.yml` and nothing outside `.github/workflows/`. This
 *    rescues historical rollouts that bundled extra workflow files.
 */
export async function classifyManagedCommit(
  ref: string,
  cwd?: string,
  preserve: Iterable<string> = []
): Promise<ManagedCommitKind | null> {
  if (await hasManagedTrailer(ref, cwd)) {
    return (await onlyManagedContent(ref, cwd, new Set(preserve)))
      ? 'trailer'
      : null;
  }
  const subject = await commitSubject(ref, cwd);
  if (subject === MANAGED_COMMIT_MESSAGE) return 'subject';
  if (subject !== null && LEGACY_MANAGED_COMMIT_MESSAGES.includes(subject)) {
    return 'legacy-subject';
  }
  if (
    (await authorEmail(ref, cwd)) === VENFORK_BOT_EMAIL &&
    (await commitTouchesWorkflowPath(ref, cwd))
  ) {
    return 'path-heuristic';
  }
  return null;
}

/** True when {@link classifyManagedCommit} finds any managed signal. */
export async function isManagedCommit(
  ref: string,
  cwd?: string,
  preserve: Iterable<string> = []
): Promise<boolean> {
  return (await classifyManagedCommit(ref, cwd, preserve)) !== null;
}

/**
 * True for kinds weak enough that dropping the commit deserves a warning:
 * anything except the trailer, which only venfork writes.
 */
export function isWeakManagedKind(kind: ManagedCommitKind): boolean {
  return kind !== 'trailer';
}

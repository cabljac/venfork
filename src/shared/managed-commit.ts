import path from 'node:path';
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

/** True for a `*.yml` / `*.yaml` file directly in `.github/workflows/`. */
export function isTopLevelWorkflow(file: string): boolean {
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

/** The workflow allow/block lists that decide which upstream workflows the managed commit removes. */
export interface WorkflowPolicy {
  enabledWorkflows: string[];
  disabledWorkflows: string[];
}

/** True when `policy` names at least one workflow in either list. */
export function hasWorkflowPolicy(policy: WorkflowPolicy): boolean {
  return (
    normalizeWorkflowList(policy.enabledWorkflows).length > 0 ||
    normalizeWorkflowList(policy.disabledWorkflows).length > 0
  );
}

/**
 * True when the managed commit keeps the workflow `file` under `policy`.
 * Precedence: a non-empty allowlist wins over the blocklist. Only top-level
 * workflows other than the sync workflow are ever removed.
 */
export function policyKeepsWorkflow(
  file: string,
  policy: WorkflowPolicy
): boolean {
  if (file === SYNC_WORKFLOW_PATH || !isTopLevelWorkflow(file)) return true;
  const base = path.posix.basename(file);
  const allowlist = normalizeWorkflowList(policy.enabledWorkflows);
  if (allowlist.length > 0) return allowlist.includes(base);
  return !normalizeWorkflowList(policy.disabledWorkflows).includes(base);
}

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
  })`git log -1 --no-show-signature --format=%(trailers:key=${MANAGED_COMMIT_TRAILER_KEY},valueonly) ${ref}`;
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
  })`git log -1 --no-show-signature --format=%s ${ref}`;
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
  })`git show --no-show-signature -z --name-only --pretty=format: ${ref}`;
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

/** One path a commit changes against its first parent. */
interface PathChange {
  status: string;
  file: string;
}

/**
 * The changes `ref` makes against its first parent that the managed commit
 * may not carry: anything except the sync workflow, a `preserve` entry, or
 * a deletion under `.github/workflows/`. With a `policy`, only deletions it
 * would make count; without one, every workflow deletion is accepted. Null
 * when git cannot list the changes.
 */
async function unmanagedChanges(
  ref: string,
  cwd: string | undefined,
  preserve: ReadonlySet<string>,
  policy: WorkflowPolicy | undefined
): Promise<PathChange[] | null> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git diff-tree -r -z --no-renames --root --no-commit-id --name-status ${ref}`;
  if (result.exitCode !== 0) return null;
  const fields = result.stdout.split('\0');
  const extra: PathChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? '';
    const file = fields[i + 1] ?? '';
    if (!status) continue;
    if (file === SYNC_WORKFLOW_PATH || preserve.has(file)) continue;
    if (
      status === 'D' &&
      file.startsWith(`${WORKFLOWS_DIR}/`) &&
      (!policy || !policyKeepsWorkflow(file, policy))
    ) {
      continue;
    }
    extra.push({ status, file });
  }
  return extra;
}

/** Which signal classified a commit as venfork-managed. */
export type ManagedCommitKind =
  | 'trailer'
  | 'stale-trailer'
  | 'subject'
  | 'legacy-subject'
  | 'path-heuristic';

async function identityEmails(
  ref: string,
  cwd?: string
): Promise<{ author: string; committer: string } | null> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git log -1 --no-show-signature --format=%ae%n%ce ${ref}`;
  if (result.exitCode !== 0) return null;
  const [author = '', committer = ''] = result.stdout.trim().split('\n');
  return { author, committer };
}

/**
 * Classifies the venfork-managed "+1 commit" so sync's divergence check and
 * stage's cherry-pick filter can skip it without losing user work. Every
 * kind except `stale-trailer` requires that the commit changes only the
 * sync workflow, `preserve` entries, and deletions under
 * `.github/workflows/` (only those `policy` makes, when given); a commit that changes anything else is null.
 * Returns the first matching signal, or null for a user commit:
 *  - `trailer`: a `Venfork-Managed: 1` trailer.
 *  - `stale-trailer`: a trailer commit authored and committed by the
 *    venfork bot whose only other changes add files that are no longer in
 *    `preserve`, or delete workflows `policy` no longer removes (a config
 *    change whose re-stamp never reached origin). Replacing it drops those
 *    files from origin and restores those workflows; nothing is published.
 *  - `subject`: subject equals `MANAGED_COMMIT_MESSAGE`.
 *  - `legacy-subject`: subject is in `LEGACY_MANAGED_COMMIT_MESSAGES`.
 *  - `path-heuristic`: authored by the venfork bot, touches the managed
 *    `venfork-sync.yml` and nothing outside `.github/workflows/`.
 */
export async function classifyManagedCommit(
  ref: string,
  cwd?: string,
  preserve: Iterable<string> = [],
  policy?: WorkflowPolicy
): Promise<ManagedCommitKind | null> {
  return (await inspectManagedCommit(ref, cwd, preserve, policy))?.kind ?? null;
}

/** A managed classification and the paths replacing the commit would discard. */
export interface ManagedCommitInspection {
  kind: ManagedCommitKind;
  /** Sorted paths a `stale-trailer` commit changes beyond the managed content; empty for every other kind. */
  staleFiles: string[];
}

/** Same signals as {@link classifyManagedCommit}, plus the stale paths of a `stale-trailer` commit. */
export async function inspectManagedCommit(
  ref: string,
  cwd?: string,
  preserve: Iterable<string> = [],
  policy?: WorkflowPolicy
): Promise<ManagedCommitInspection | null> {
  const extra = await unmanagedChanges(ref, cwd, new Set(preserve), policy);
  if (extra === null) return null;
  const found = (kind: ManagedCommitKind): ManagedCommitInspection => ({
    kind,
    staleFiles: [],
  });
  if (await hasManagedTrailer(ref, cwd)) {
    if (extra.length === 0) return found('trailer');
    const emails = await identityEmails(ref, cwd);
    const botMade =
      emails?.author === VENFORK_BOT_EMAIL &&
      emails.committer === VENFORK_BOT_EMAIL;
    return botMade &&
      extra.every(
        (change) =>
          change.status === 'A' ||
          (change.status === 'D' && change.file.startsWith(`${WORKFLOWS_DIR}/`))
      )
      ? {
          kind: 'stale-trailer',
          staleFiles: extra.map((change) => change.file).sort(),
        }
      : null;
  }
  if (extra.length > 0) return null;
  const subject = await commitSubject(ref, cwd);
  if (subject === MANAGED_COMMIT_MESSAGE) return found('subject');
  if (subject !== null && LEGACY_MANAGED_COMMIT_MESSAGES.includes(subject)) {
    return found('legacy-subject');
  }
  if (
    (await identityEmails(ref, cwd))?.author === VENFORK_BOT_EMAIL &&
    (await commitTouchesWorkflowPath(ref, cwd))
  ) {
    return found('path-heuristic');
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

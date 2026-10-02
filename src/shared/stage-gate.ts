import { $ } from 'execa';
import { GitError, MirrorReferenceError, StageLeakError } from '../errors.js';
import { SYNC_WORKFLOW_PATH, VENFORK_BOT_EMAIL } from './constants.js';
import { findDeniedText } from './deny-list.js';

/** Git's object id for the empty blob; an empty file is not mirror content. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

interface TreeChange {
  status: string;
  path: string;
  newOid: string;
}

/** True for paths that only ever exist on the private mirror. */
function isMirrorOnlyPath(file: string): boolean {
  return (
    file === SYNC_WORKFLOW_PATH ||
    file === '.venfork' ||
    file.startsWith('.venfork/')
  );
}

async function blobAt(
  ref: string,
  file: string,
  cwd: string
): Promise<string | null> {
  const result = await $({
    cwd,
    reject: false,
  })`git --literal-pathspecs ls-tree -z ${ref} -- ${file}`;
  if (result.exitCode !== 0) return null;
  for (const entry of result.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1 || entry.slice(tab + 1) !== file) continue;
    const [, type, oid] = entry.slice(0, tab).split(' ');
    return type === 'blob' ? (oid ?? null) : null;
  }
  return null;
}

async function treeChanges(commit: string, cwd: string): Promise<TreeChange[]> {
  const result = await $({
    cwd,
    reject: false,
  })`git diff-tree -r -z --no-renames --root --no-commit-id ${commit}`;
  if (result.exitCode !== 0) {
    throw new GitError(
      `Cannot list the files commit ${commit} changes: ${result.stderr.trim()}`,
      'git diff-tree'
    );
  }
  const fields = result.stdout.split('\0');
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    if (!meta?.startsWith(':')) continue;
    const [, , , newOid, status] = meta.slice(1).split(' ');
    changes.push({
      status: (status ?? '').charAt(0),
      path: fields[i + 1] ?? '',
      newOid: newOid ?? '',
    });
  }
  return changes;
}

/**
 * Blob ids of the preserved files and the managed sync workflow as the
 * mirror holds them at `refs`, mapped to the path they were found at. A
 * blob identical to upstream's file at the same path is left out: it is
 * upstream content, not mirror content.
 *
 * @param refs Mirror commits to read (missing refs are skipped).
 * @param preserve The preserve allowlist.
 * @param base `upstream/<default>`.
 * @param cwd Mirror checkout.
 */
export async function collectMirrorBlobs(
  refs: readonly string[],
  preserve: readonly string[],
  base: string,
  cwd: string
): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  const paths = [...new Set([...preserve, SYNC_WORKFLOW_PATH])];
  for (const file of paths) {
    const upstreamBlob = await blobAt(base, file, cwd);
    for (const ref of refs) {
      const oid = await blobAt(ref, file, cwd);
      if (oid && oid !== upstreamBlob && oid !== EMPTY_BLOB) {
        blobs.set(oid, file);
      }
    }
  }
  return blobs;
}

/** Inputs for {@link assertPublishableCommits}. */
export interface StageGateInput {
  /** Branch name, for error messages. */
  branch: string;
  /** `upstream/<default>`; the rebuilt head sits linearly on top of it. */
  base: string;
  /** Rebuilt head that would be pushed. */
  head: string;
  /** The preserve allowlist. */
  preserve: readonly string[];
  /** Output of {@link collectMirrorBlobs}. */
  mirrorBlobs: ReadonlyMap<string, string>;
  /** Output of `mirrorDenyList`. */
  denyList: readonly string[];
  /** Rebuilt commit id to the branch commit it was cherry-picked from. */
  originalOf: ReadonlyMap<string, string>;
  /** Mirror checkout. */
  cwd: string;
}

/**
 * Checks every commit in `base..head` before anything is pushed and throws
 * on the first one that would publish mirror state:
 *  - {@link StageLeakError} when it adds, modifies or retypes the managed
 *    sync workflow, anything under `.venfork/`, or a preserved path (unless
 *    the result is upstream's exact blob at that path), or when it adds a
 *    blob identical to mirror-held preserved content at any path.
 *  - {@link MirrorReferenceError} when the venfork bot authored or
 *    committed it, or its author, committer or message contains a
 *    deny-list term.
 *
 * Deleting a preserved path is allowed: no content leaves.
 */
export async function assertPublishableCommits(
  input: StageGateInput
): Promise<void> {
  const { branch, base, head, preserve, mirrorBlobs, denyList, cwd } = input;
  const list = await $({
    cwd,
  })`git rev-list --reverse ${base}..${head}`;
  const commits = list.stdout.split('\n').filter(Boolean);
  const upstreamBlobs = new Map<string, string | null>();

  for (const commit of commits) {
    const label = (input.originalOf.get(commit) ?? commit).slice(0, 12);

    const leaks: string[] = [];
    for (const change of await treeChanges(commit, cwd)) {
      if (change.status === 'D') continue;
      if (isMirrorOnlyPath(change.path)) {
        leaks.push(change.path);
        continue;
      }
      if (preserve.includes(change.path)) {
        if (!upstreamBlobs.has(change.path)) {
          upstreamBlobs.set(change.path, await blobAt(base, change.path, cwd));
        }
        if (change.newOid !== upstreamBlobs.get(change.path)) {
          leaks.push(change.path);
          continue;
        }
      }
      const source = mirrorBlobs.get(change.newOid);
      if (source !== undefined) {
        leaks.push(`${change.path} (content of ${source})`);
      }
    }
    if (leaks.length > 0) {
      throw new StageLeakError(branch, leaks, label);
    }

    const meta = await $({
      cwd,
    })`git show -s --format=%an%x00%ae%x00%cn%x00%ce%x00%B ${commit}`;
    const [authorName, authorEmail, committerName, committerEmail, ...rest] =
      meta.stdout.split('\0');
    const bot = VENFORK_BOT_EMAIL.toLowerCase();
    if (
      authorEmail?.toLowerCase() === bot ||
      committerEmail?.toLowerCase() === bot
    ) {
      throw new MirrorReferenceError(
        `commit ${label} (made by the venfork bot)`,
        VENFORK_BOT_EMAIL,
        'Rewrite the branch so no commit is authored or committed by the venfork bot and retry.'
      );
    }
    const fields: Array<[string, string]> = [
      ['author name', authorName ?? ''],
      ['author email', authorEmail ?? ''],
      ['committer name', committerName ?? ''],
      ['committer email', committerEmail ?? ''],
      ['message', rest.join('\0')],
    ];
    for (const [field, value] of fields) {
      const matched = findDeniedText(value, denyList);
      if (matched !== null) {
        throw new MirrorReferenceError(
          `commit ${label} ${field}`,
          matched,
          `Rewrite the branch so no commit contains '${matched}' and retry.`
        );
      }
    }
  }
}

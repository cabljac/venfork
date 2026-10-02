import { $ } from 'execa';
import { GitError, MirrorReferenceError, StageLeakError } from '../errors.js';
import { SYNC_WORKFLOW_PATH, VENFORK_BOT_EMAIL } from './constants.js';
import {
  canonicalText,
  findDeniedText,
  mirrorLocationTerms,
} from './deny-list.js';

/** Git's object id for the empty blob; an empty file is not mirror content. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** Repo-relative path of the config file on the `venfork-config` branch. */
const CONFIG_PATH = '.venfork/config.json';

const CONFIG_SIGNATURE = '"upstreamUrl" and "publicForkUrl" keys';

/** Most commits of history read per preserved path. */
const HISTORY_COMMIT_CAP = 500;

/** A blob with a NUL in its first bytes is binary and not text-scanned. */
const BINARY_SNIFF_BYTES = 8000;

const GITLINK_MODE = '160000';

interface TreeChange {
  status: string;
  path: string;
  newMode: string;
  newOid: string;
}

interface TreeBlob {
  path: string;
  oid: string;
}

function foldPath(file: string): string {
  return file.normalize('NFC').toLowerCase();
}

/** True for paths that only ever exist on the private mirror. */
function isMirrorOnlyPath(file: string): boolean {
  const folded = foldPath(file);
  return (
    folded === foldPath(SYNC_WORKFLOW_PATH) ||
    folded === '.venfork' ||
    folded.startsWith('.venfork/')
  );
}

/** True when `file` is a preserve entry or lies under one (a directory entry). */
function isPreservedPath(file: string, preserve: readonly string[]): boolean {
  const folded = foldPath(file);
  return preserve.some((entry) => {
    const entryFolded = foldPath(entry);
    return folded === entryFolded || folded.startsWith(`${entryFolded}/`);
  });
}

/** True for text shaped like a venfork `config.json`, whatever its values. */
function looksLikeVenforkConfig(text: string): boolean {
  const folded = canonicalText(text).toLowerCase();
  return folded.includes('"upstreamurl"') && folded.includes('"publicforkurl"');
}

function parseTreeEntries(stdout: string): TreeBlob[] {
  const blobs: TreeBlob[] = [];
  for (const entry of stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [, type, oid] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && oid) blobs.push({ path: entry.slice(tab + 1), oid });
  }
  return blobs;
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
  return (
    parseTreeEntries(result.stdout).find((blob) => blob.path === file)?.oid ??
    null
  );
}

/** Every blob at or under `entry` in `ref` (a file entry yields itself). */
async function blobsUnder(
  ref: string,
  entry: string,
  cwd: string
): Promise<TreeBlob[]> {
  const result = await $({
    cwd,
    reject: false,
  })`git --literal-pathspecs ls-tree -r -z ${ref} -- ${entry}`;
  return result.exitCode === 0 ? parseTreeEntries(result.stdout) : [];
}

/**
 * The existing commits among `refs`, up to the cap of commits in their
 * history that touched `entry`, and up to the cap of reflog entries per ref
 * (a forced push leaves the old tip only there).
 */
async function commitsTouching(
  refs: readonly string[],
  entry: string,
  cwd: string
): Promise<string[]> {
  const tips: string[] = [];
  for (const ref of refs) {
    const check = await $({
      cwd,
      reject: false,
    })`git rev-parse --verify --quiet ${`${ref}^{commit}`}`;
    if (check.exitCode === 0) tips.push(ref);
  }
  if (tips.length === 0) return [];
  const log = await $({
    cwd,
    reject: false,
  })`git --literal-pathspecs log --format=%H --full-history --max-count=${HISTORY_COMMIT_CAP} ${tips} -- ${entry}`;
  const found = log.exitCode === 0 ? log.stdout.split('\n') : [];
  for (const ref of tips) {
    const reflog = await $({
      cwd,
      reject: false,
    })`git log -g --format=%H --max-count=${HISTORY_COMMIT_CAP} ${ref}`;
    if (reflog.exitCode === 0) found.push(...reflog.stdout.split('\n'));
  }
  return [...new Set([...tips, ...found.filter(Boolean)])];
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
    const [, newMode, , newOid, status] = meta.slice(1).split(' ');
    changes.push({
      status: (status ?? '').charAt(0),
      path: fields[i + 1] ?? '',
      newMode: newMode ?? '',
      newOid: newOid ?? '',
    });
  }
  return changes;
}

/**
 * Blob ids of the preserved files, the managed sync workflow and the
 * venfork config as the mirror holds or ever held them, mapped to the path
 * they were found at. A preserve entry that is a directory contributes every
 * file under it. A blob identical to upstream's file at the same path is
 * left out: it is upstream content, not mirror content.
 *
 * For each entry, `refs` are read at their tips, at up to 500 commits of
 * their history that touched it and at up to 500 reflog entries each; older
 * versions are not covered.
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
  const upstreamBlobs = new Map<string, string | null>();

  const collect = async (
    from: readonly string[],
    entry: string,
    label?: string
  ): Promise<void> => {
    for (const commit of await commitsTouching(from, entry, cwd)) {
      for (const blob of await blobsUnder(commit, entry, cwd)) {
        if (!upstreamBlobs.has(blob.path)) {
          upstreamBlobs.set(blob.path, await blobAt(base, blob.path, cwd));
        }
        if (
          blob.oid !== upstreamBlobs.get(blob.path) &&
          blob.oid !== EMPTY_BLOB
        ) {
          blobs.set(blob.oid, label ?? blob.path);
        }
      }
    }
  };

  for (const entry of new Set([...preserve, SYNC_WORKFLOW_PATH])) {
    await collect(refs, entry);
  }
  await collect(
    ['refs/remotes/origin/venfork-config', 'refs/heads/venfork-config'],
    CONFIG_PATH
  );
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

/** Reads a blob as text, or null when it looks binary. */
async function textOf(oid: string, cwd: string): Promise<string | null> {
  const result = await $({
    cwd,
    encoding: 'latin1',
  })`git cat-file blob ${oid}`;
  if (result.stdout.slice(0, BINARY_SNIFF_BYTES).includes('\0')) return null;
  return Buffer.from(result.stdout, 'latin1').toString('utf8');
}

/**
 * Checks every commit in `base..head` before anything is pushed and throws
 * on the first one that would publish mirror state:
 *  - {@link StageLeakError} when it adds, modifies or retypes the managed
 *    sync workflow, anything under `.venfork/`, or a preserved path (or a
 *    path under a directory entry), matched case-insensitively, unless the
 *    result is upstream's exact blob at that path, or when it adds a blob
 *    identical to mirror-held content at any path.
 *  - {@link MirrorReferenceError} when an added or modified text file, or
 *    any file name, contains a mirror deny-list term (never the bare word
 *    `venfork`) or looks like a venfork `config.json`; or when the venfork
 *    bot authored or committed the commit, or its author, committer or
 *    message contains a deny-list term. Binary files are not scanned.
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
  const locationTerms = mirrorLocationTerms(denyList);
  const scanned = new Map<string, string | null>();

  for (const commit of commits) {
    const label = (input.originalOf.get(commit) ?? commit).slice(0, 12);

    const leaks: string[] = [];
    const published: TreeChange[] = [];
    for (const change of await treeChanges(commit, cwd)) {
      if (change.status === 'D') continue;
      published.push(change);
      if (isMirrorOnlyPath(change.path)) {
        leaks.push(change.path);
        continue;
      }
      if (isPreservedPath(change.path, preserve)) {
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

    for (const change of published) {
      const nameHit = findDeniedText(change.path, locationTerms);
      if (nameHit !== null) {
        throw new MirrorReferenceError(
          `commit ${label} file name ${change.path}`,
          nameHit,
          `Rename the file so no commit contains '${nameHit}' and retry.`
        );
      }
      if (change.newMode === GITLINK_MODE) continue;
      if (!scanned.has(change.newOid)) {
        scanned.set(change.newOid, await textOf(change.newOid, cwd));
      }
      const text = scanned.get(change.newOid);
      if (text === null || text === undefined) continue;
      const hit = looksLikeVenforkConfig(text)
        ? CONFIG_SIGNATURE
        : findDeniedText(text, locationTerms);
      if (hit !== null) {
        throw new MirrorReferenceError(
          `commit ${label} file ${change.path}`,
          hit,
          `Remove it from ${change.path} and retry.`
        );
      }
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

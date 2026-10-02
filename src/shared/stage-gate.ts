import { $ } from 'execa';
import {
  GitError,
  MirrorReferenceError,
  StageLeakError,
  VenforkError,
} from '../errors.js';
import { SYNC_WORKFLOW_PATH, VENFORK_BOT_EMAIL } from './constants.js';
import {
  canonicalText,
  findDeniedText,
  mirrorLocationTerms,
  selfReferenceAllowed,
} from './deny-list.js';

/** Git's object id for the empty blob; an empty file is not mirror content. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** Repo-relative path of the config file on the `venfork-config` branch. */
const CONFIG_PATH = '.venfork/config.json';

const CONFIG_SIGNATURE = '"upstreamUrl" and "publicForkUrl" keys';

/** Default for {@link CollectMirrorBlobsOptions.historyCap}. */
const HISTORY_COMMIT_CAP = 2000;

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

function isUrlLike(value: unknown): boolean {
  return typeof value === 'string' && /[/:]/.test(value) && !/\s/.test(value);
}

/**
 * True for a JSON object shaped like a venfork `config.json`, whatever its
 * values: a `version` key, a URL-valued `upstreamUrl` and, when present, a
 * URL-valued `publicForkUrl`. Never true when self-reference is allowed.
 */
function looksLikeVenforkConfig(text: string): boolean {
  if (selfReferenceAllowed()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalText(text));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const fields = new Map(
    Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), value])
  );
  return (
    fields.has('version') &&
    isUrlLike(fields.get('upstreamurl')) &&
    (!fields.has('publicforkurl') || isUrlLike(fields.get('publicforkurl')))
  );
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

interface ObjectInfo {
  oid: string;
  type: string;
}

/**
 * Resolves each spec (`<rev>`, `<tree>:<path>`) with one
 * `git cat-file --batch-check`; null for a missing object.
 */
async function batchCheck(
  specs: readonly string[],
  cwd: string
): Promise<Array<ObjectInfo | null>> {
  if (specs.length === 0) return [];
  const bad = specs.find((spec) => spec.includes('\n'));
  if (bad !== undefined) {
    throw new GitError(
      `Cannot look up ${JSON.stringify(bad)}: it contains a newline`,
      'git cat-file'
    );
  }
  const result = await $({
    cwd,
    reject: false,
    input: `${specs.join('\n')}\n`,
  })`git cat-file ${'--batch-check=%(objectname) %(objecttype)'}`;
  if (result.exitCode !== 0) {
    throw new GitError(
      `Cannot read mirror objects: ${result.stderr.trim()}`,
      'git cat-file'
    );
  }
  const lines = result.stdout.split('\n');
  return specs.map((_, i) => {
    const match = lines[i]?.match(/^([0-9a-f]{40,64}) (\S+)$/);
    return match ? { oid: match[1] ?? '', type: match[2] ?? '' } : null;
  });
}

/** Refs whose history holds the listed mirror-only paths. */
interface HistoryGroup {
  refs: readonly string[];
  entries: readonly string[];
  /** Warn when a remote-tracking ref among `refs` has an empty reflog. */
  warnOnEmptyReflog: boolean;
}

/**
 * Tree ids of the existing commits among `refs`, of their reflog entries (a
 * forced push leaves the old tip only there) and of the history of both
 * that `base` cannot reach, newest first, capped and deduplicated.
 */
async function mirrorTrees(
  group: HistoryGroup,
  base: string,
  cap: number,
  warnings: string[],
  cwd: string
): Promise<string[]> {
  const resolved = await batchCheck(
    group.refs.map((ref) => `${ref}^{commit}`),
    cwd
  );
  const starts = new Set<string>();
  for (const [i, ref] of group.refs.entries()) {
    const commit = resolved[i];
    if (!commit) continue;
    starts.add(commit.oid);
    if (!ref.startsWith('refs/')) continue;
    const reflog = await $({
      cwd,
      reject: false,
    })`git log -g --format=%H --max-count=${cap} ${ref}`;
    const entries =
      reflog.exitCode === 0 ? reflog.stdout.split('\n').filter(Boolean) : [];
    for (const entry of entries) starts.add(entry);
    if (entries.length >= cap) {
      warnings.push(
        `Read only the newest ${cap} reflog entries of ${ref}; mirror-only history older than that cannot be checked.`
      );
    } else if (
      entries.length === 0 &&
      group.warnOnEmptyReflog &&
      ref.startsWith('refs/remotes/')
    ) {
      warnings.push(
        `${ref} has no reflog; mirror-only history older than the reflog cannot be checked.`
      );
    }
  }
  if (starts.size === 0) return [];
  const log = await $({
    cwd,
    reject: false,
    input: `${[...starts].join('\n')}\n`,
  })`git log --format=%T --max-count=${cap} --stdin ${`^${base}`}`;
  if (log.exitCode !== 0) {
    throw new GitError(
      `Cannot read mirror history: ${log.stderr.trim()}`,
      'git log'
    );
  }
  const trees = log.stdout.split('\n').filter(Boolean);
  if (trees.length >= cap) {
    warnings.push(
      `Read only the newest ${cap} commits of mirror history; mirror-only history older than that cannot be checked.`
    );
  }
  return [...new Set(trees)];
}

/** Every blob at or under each entry in each tree (a file entry yields itself). */
async function blobsInTrees(
  trees: readonly string[],
  entries: readonly string[],
  cwd: string
): Promise<TreeBlob[]> {
  const specs: Array<{ entry: string; spec: string }> = [];
  for (const tree of trees) {
    for (const entry of entries) {
      specs.push({ entry, spec: `${tree}:${entry}` });
    }
  }
  const found = await batchCheck(
    specs.map(({ spec }) => spec),
    cwd
  );
  const blobs: TreeBlob[] = [];
  const subtrees = new Map<string, { oid: string; entry: string }>();
  for (const [i, info] of found.entries()) {
    const entry = specs[i]?.entry ?? '';
    if (info?.type === 'blob') blobs.push({ path: entry, oid: info.oid });
    if (info?.type === 'tree') {
      subtrees.set(`${info.oid}\0${entry}`, { oid: info.oid, entry });
    }
  }
  for (const { oid, entry } of subtrees.values()) {
    const listing = await $({ cwd })`git ls-tree -r -z ${oid}`;
    for (const blob of parseTreeEntries(listing.stdout)) {
      blobs.push({ path: `${entry}/${blob.path}`, oid: blob.oid });
    }
  }
  return blobs;
}

/**
 * `<path>\0<oid>` for every version of `paths` at `base` and in its
 * history: content upstream has already published.
 */
async function upstreamVersions(
  paths: readonly string[],
  base: string,
  cwd: string
): Promise<Set<string>> {
  const versions = new Set<string>();
  if (paths.length === 0) return versions;
  const tip = await $({
    cwd,
  })`git --literal-pathspecs ls-tree -r -z ${base} -- ${paths}`;
  for (const blob of parseTreeEntries(tip.stdout)) {
    versions.add(`${blob.path}\0${blob.oid}`);
  }
  const history = await $({
    cwd,
  })`git --literal-pathspecs log --format= --raw -z --no-abbrev --no-renames --full-history ${base} -- ${paths}`;
  const fields = history.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i++) {
    const meta = fields[i]?.replace(/^\n+/, '') ?? '';
    if (!meta.startsWith(':')) continue;
    const [, , oldOid, newOid] = meta.slice(1).split(' ');
    const file = fields[i + 1] ?? '';
    for (const oid of [oldOid, newOid]) {
      if (oid) versions.add(`${file}\0${oid}`);
    }
    i++;
  }
  return versions;
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

/** Options for {@link collectMirrorBlobs}. */
export interface CollectMirrorBlobsOptions {
  /** Most commits read per history, and most reflog entries read per ref. */
  historyCap?: number;
}

/** Output of {@link collectMirrorBlobs}. */
export interface MirrorBlobs {
  /** Mirror-held blob id to the path it was found at. */
  blobs: Map<string, string>;
  /** History the scan could not cover, worded for the user. */
  warnings: string[];
}

/**
 * Blob ids of the preserved files, the managed sync workflow and the
 * venfork config as the mirror holds or ever held them, mapped to the path
 * they were found at. A preserve entry that is a directory contributes every
 * file under it. A blob that is a version of the same path at `base` or in
 * its history is left out: it is upstream content, not mirror content.
 *
 * `refs` (and the venfork-config refs) are read at their tips, at their
 * reflog entries and in the history of both that `base` cannot reach, up to
 * `historyCap` commits and reflog entries per ref. Older versions are not
 * covered; {@link MirrorBlobs.warnings} says when that may matter.
 *
 * @param refs Mirror commits to read (missing refs are skipped).
 * @param preserve The preserve allowlist.
 * @param base `upstream/<default>`.
 * @param cwd Mirror checkout.
 * @param options Scan limits.
 */
export async function collectMirrorBlobs(
  refs: readonly string[],
  preserve: readonly string[],
  base: string,
  cwd: string,
  options: CollectMirrorBlobsOptions = {}
): Promise<MirrorBlobs> {
  const cap = options.historyCap ?? HISTORY_COMMIT_CAP;
  const warnings: string[] = [];
  const groups: HistoryGroup[] = [
    {
      refs,
      entries: [...new Set([...preserve, SYNC_WORKFLOW_PATH])],
      warnOnEmptyReflog: true,
    },
    {
      refs: ['refs/remotes/origin/venfork-config', 'refs/heads/venfork-config'],
      entries: [CONFIG_PATH],
      warnOnEmptyReflog: false,
    },
  ];
  const found: TreeBlob[] = [];
  for (const group of groups) {
    const trees = await mirrorTrees(group, base, cap, warnings, cwd);
    found.push(...(await blobsInTrees(trees, group.entries, cwd)));
  }
  const upstream = await upstreamVersions(
    [...new Set(found.map((blob) => blob.path))],
    base,
    cwd
  );
  const blobs = new Map<string, string>();
  for (const blob of found) {
    if (blob.oid === EMPTY_BLOB) continue;
    if (upstream.has(`${blob.path}\0${blob.oid}`)) continue;
    blobs.set(blob.oid, blob.path);
  }
  return { blobs, warnings };
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

function isMaxBufferError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'isMaxBuffer' in err &&
    err.isMaxBuffer === true
  );
}

/** Reads a blob's bytes; a blob over execa's buffer limit is refused. */
async function bytesOf(
  oid: string,
  where: string,
  cwd: string
): Promise<Buffer> {
  try {
    const result = await $({
      cwd,
      // `encoding: 'buffer'` throws "Unknown encoding" under Bun.
      encoding: 'latin1',
    })`git cat-file blob ${oid}`;
    return Buffer.from(result.stdout, 'latin1');
  } catch (err) {
    if (isMaxBufferError(err)) {
      throw new VenforkError(
        `Refusing to publish: ${where} is too large to check for mirror references (over 100 MB). Remove it from the branch and retry.`
      );
    }
    throw err;
  }
}

/**
 * Decodes UTF-16 (with a byte order mark) and UTF-8 text; null when the
 * bytes look binary (a NUL in the first 8000 bytes).
 */
function decodeText(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  return bytes.toString('utf8');
}

/**
 * The first URL-derived term (one with a `/` or `:`) found in binary bytes
 * as UTF-8 or UTF-16LE, ignoring ASCII case. A bare repo name is not
 * searched: it matches too much binary data.
 */
function findTermInBytes(
  bytes: Buffer,
  terms: readonly string[]
): string | null {
  const haystack = bytes.toString('latin1').toLowerCase();
  for (const term of terms) {
    if (!/[/:]/.test(term)) continue;
    for (const encoding of ['utf8', 'utf16le'] as const) {
      const needle = Buffer.from(term, encoding).toString('latin1');
      if (haystack.includes(needle.toLowerCase())) return term;
    }
  }
  return null;
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
 *    message contains a deny-list term. Text is read as UTF-8, or UTF-16
 *    when it starts with a byte order mark; a binary file is searched only
 *    for the URL-derived terms, as UTF-8 and UTF-16LE bytes.
 *  - {@link VenforkError} when a file is too large to read.
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
      let hit = scanned.get(change.newOid);
      if (hit === undefined) {
        const bytes = await bytesOf(
          change.newOid,
          `commit ${label} file ${change.path}`,
          cwd
        );
        const text = decodeText(bytes);
        if (text === null) {
          hit = findTermInBytes(bytes, locationTerms);
        } else {
          hit = looksLikeVenforkConfig(text)
            ? CONFIG_SIGNATURE
            : findDeniedText(text, locationTerms);
        }
        scanned.set(change.newOid, hit);
      }
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

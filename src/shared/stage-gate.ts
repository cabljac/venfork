import { createHash } from 'node:crypto';
import { $ } from 'execa';
import { invalidPreserveError } from '../config.js';
import {
  GitError,
  MirrorReferenceError,
  StageLeakError,
  VenforkError,
} from '../errors.js';
import { parseRepoPath } from '../utils.js';
import { SYNC_WORKFLOW_PATH, VENFORK_BOT_EMAIL } from './constants.js';
import {
  canonicalText,
  findDeniedText,
  mirrorLocationTerms,
  selfReferenceAllowed,
} from './deny-list.js';
import { findMarkerText } from './redaction.js';

/** Git's object id for the empty blob; an empty file is not mirror content. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** Repo-relative path of the config file on the `venfork-config` branch. */
const CONFIG_PATH = '.venfork/config.json';

const CONFIG_SIGNATURE =
  'a venfork config (an "upstreamUrl" key with "publicForkUrl", "mode": "no-public", "preserve", "schedule" or a link map)';

/** Default for {@link CollectMirrorBlobsOptions.historyCap}. */
const HISTORY_COMMIT_CAP = 20000;

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

/** Config keys, lowercased, that hold links between mirror and upstream work. */
const LINK_MAP_KEYS = [
  'shippedbranches',
  'pulledprs',
  'shippedissues',
  'pulledissues',
];

/** Lowercased config keys only venfork writes, beside `publicForkUrl` and `mode`. */
const VENFORK_ONLY_KEYS = [...LINK_MAP_KEYS, 'preserve', 'schedule'];

/** Compares repo URLs by `owner/repo`, or by the URL itself when it is not GitHub. */
function repoKey(url: string): string {
  return (
    parseRepoPath(url) ||
    url
      .trim()
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '')
  ).toLowerCase();
}

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return (
    typeof value === 'object' && value !== null && Object.keys(value).length > 0
  );
}

/**
 * True for a JSON object shaped like a venfork `config.json`: a URL-valued
 * `upstreamUrl` plus a URL-valued `publicForkUrl`, `"mode": "no-public"`
 * or any of `preserve`, `schedule` and the link maps. When self-reference
 * is allowed, only such an object that names one of `recordedUrls` or
 * holds a non-empty link map.
 */
function looksLikeVenforkConfig(
  text: string,
  recordedUrls: readonly string[]
): boolean {
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
  const upstreamUrl = fields.get('upstreamurl');
  const publicForkUrl = fields.get('publicforkurl');
  if (!isUrlLike(upstreamUrl)) return false;
  const venforkShaped =
    isUrlLike(publicForkUrl) ||
    fields.get('mode') === 'no-public' ||
    VENFORK_ONLY_KEYS.some((key) => fields.has(key));
  if (!venforkShaped) return false;
  if (!selfReferenceAllowed()) return true;
  const recorded = new Set(recordedUrls.map(repoKey));
  const named = [upstreamUrl, publicForkUrl].some(
    (url) => typeof url === 'string' && recorded.has(repoKey(url))
  );
  return named || LINK_MAP_KEYS.some((key) => isNonEmpty(fields.get(key)));
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
}

/** How to proceed when mirror history is longer than the scan reads. */
const OVER_CAP_REMEDY =
  'Stage from a clone whose reflog is shorter, or, after confirming no mirror-only history older than that is needed, drop old entries with `git reflog expire --expire=<date> --all`.';

/**
 * Tree ids of the existing commits among `refs`, of their reflog entries (a
 * forced push leaves the old tip only there) and of the history of both
 * that `base` cannot reach, newest first and deduplicated. Throws when a
 * reflog or that history is longer than `cap`: it could not all be read.
 */
async function mirrorTrees(
  group: HistoryGroup,
  base: string,
  cap: number,
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
    })`git log -g --format=%H --max-count=${cap + 1} ${ref}`;
    const entries =
      reflog.exitCode === 0 ? reflog.stdout.split('\n').filter(Boolean) : [];
    if (entries.length > cap) {
      throw new VenforkError(
        `Refusing to publish: ${ref} has more than ${cap} reflog entries, and venfork checks at most ${cap}, so older mirror-only history cannot be checked. ${OVER_CAP_REMEDY}`
      );
    }
    for (const entry of entries) starts.add(entry);
  }
  if (starts.size === 0) return [];
  const log = await $({
    cwd,
    reject: false,
    input: `${[...starts].join('\n')}\n`,
  })`git log --format=%T --max-count=${cap + 1} --stdin ${`^${base}`}`;
  if (log.exitCode !== 0) {
    throw new GitError(
      `Cannot read mirror history: ${log.stderr.trim()}`,
      'git log'
    );
  }
  const trees = log.stdout.split('\n').filter(Boolean);
  if (trees.length > cap) {
    throw new VenforkError(
      `Refusing to publish: the mirror holds more than ${cap} commits that ${base} does not, and venfork checks at most ${cap}, so older mirror-only history cannot be checked. ${OVER_CAP_REMEDY}`
    );
  }
  return [...new Set(trees)];
}

/** Every blob at or under each entry in each tree (a file entry yields itself). */
async function blobsInTrees(
  trees: readonly string[],
  entries: readonly string[],
  preserve: readonly string[],
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
  for (const [i, info] of found.entries()) {
    const entry = specs[i]?.entry ?? '';
    if (info?.type === 'blob') blobs.push({ path: entry, oid: info.oid });
    if (info?.type === 'tree') {
      if (preserve.includes(entry)) throw invalidPreserveError([entry]);
      throw new VenforkError(
        `Refusing to publish: ${entry} is a directory in the mirror history, where venfork only ever writes a file. Remove it from the mirror history and retry.`
      );
    }
  }
  return blobs;
}

/**
 * Throws the invalid preserve entry {@link ConfigError} when any entry in
 * `preserve` is a directory at one of `refs` (missing refs are skipped).
 * Preserve accepts single files only; a directory entry left by an old
 * config would otherwise protect nothing under it.
 *
 * @param preserve The preserve allowlist.
 * @param refs Mirror commits to look in, such as `origin/<default>`.
 * @param cwd Mirror checkout.
 */
export async function assertPreserveEntriesAreNotDirectories(
  preserve: readonly string[],
  refs: readonly string[],
  cwd: string
): Promise<void> {
  if (preserve.length === 0) return;
  const specs = refs.flatMap((ref) =>
    preserve.map((entry) => ({ entry, spec: `${ref}:${entry}` }))
  );
  const found = await batchCheck(
    specs.map(({ spec }) => spec),
    cwd
  );
  const directories = new Set<string>();
  for (const [i, info] of found.entries()) {
    if (info?.type === 'tree') directories.add(specs[i]?.entry ?? '');
  }
  if (directories.size > 0) {
    throw invalidPreserveError([...directories].sort());
  }
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

/** Normalized form of a text blob, for matching copies that differ in form. */
interface TextShape {
  /** Hash of the normalized text. */
  fingerprint: string;
  /** Normalized lines of at least {@link MIN_SHINGLE_LENGTH} characters. */
  lines: ReadonlySet<string>;
}

/** A mirror-held text blob, as {@link collectMirrorBlobs} reads it. */
export interface MirrorText extends TextShape {
  /** Path the blob was found at. */
  path: string;
}

/** Output of {@link collectMirrorBlobs}. */
export interface MirrorBlobs {
  /** Mirror-held blob id to the path it was found at. */
  blobs: Map<string, string>;
  /** Normalized shape of each mirror-held text blob. */
  texts: MirrorText[];
}

/** A line shorter than this is too common to show that text was copied. */
const MIN_SHINGLE_LENGTH = 20;

/** Fewest long lines a mirror text needs before line overlap is judged. */
const MIN_SHINGLE_LINES = 3;

/** A published text sharing more than this share of a mirror text's long lines is a copy. */
const SHINGLE_SHARE = 0.5;

/** Mirror blobs over this size are not fingerprinted. */
const MAX_FINGERPRINT_BYTES = 1024 * 1024;

/** Blobs read per `git cat-file --batch` call. */
const FINGERPRINT_BATCH = 100;

/**
 * Lines of `text` with case, invisible characters, a byte order mark, line
 * ending style and runs of whitespace removed; blank lines are dropped.
 */
function normalizedLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = canonicalText(raw).toLowerCase().replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines;
}

function shapeOf(text: string): TextShape | null {
  const lines = normalizedLines(text);
  if (lines.length === 0) return null;
  return {
    fingerprint: createHash('sha256').update(lines.join('\n')).digest('hex'),
    lines: new Set(lines.filter((line) => line.length >= MIN_SHINGLE_LENGTH)),
  };
}

/** Bytes of each blob in `oids` of at most {@link MAX_FINGERPRINT_BYTES}. */
async function readSmallBlobs(
  oids: readonly string[],
  cwd: string
): Promise<Map<string, Buffer>> {
  const bytes = new Map<string, Buffer>();
  for (let i = 0; i < oids.length; i += FINGERPRINT_BATCH) {
    const chunk = oids.slice(i, i + FINGERPRINT_BATCH);
    const sizes = await $({
      cwd,
      reject: false,
      input: `${chunk.join('\n')}\n`,
    })`git cat-file ${'--batch-check=%(objectname) %(objectsize)'}`;
    if (sizes.exitCode !== 0) {
      throw new GitError(
        `Cannot read mirror objects: ${sizes.stderr.trim()}`,
        'git cat-file'
      );
    }
    const small = chunk.filter((_, at) => {
      const size = Number(sizes.stdout.split('\n')[at]?.split(' ')[1]);
      return Number.isFinite(size) && size <= MAX_FINGERPRINT_BYTES;
    });
    if (small.length === 0) continue;
    const batch = await $({
      cwd,
      encoding: 'latin1',
      input: `${small.join('\n')}\n`,
    })`git cat-file --batch`;
    let at = 0;
    while (at < batch.stdout.length) {
      const end = batch.stdout.indexOf('\n', at);
      if (end === -1) break;
      const [oid, , size] = batch.stdout.slice(at, end).split(' ');
      const length = Number(size);
      if (!oid || !Number.isFinite(length)) {
        at = end + 1;
        continue;
      }
      bytes.set(
        oid,
        Buffer.from(batch.stdout.slice(end + 1, end + 1 + length), 'latin1')
      );
      at = end + 1 + length + 1;
    }
  }
  return bytes;
}

/**
 * The mirror text shapes, with the lines upstream's own version of the same
 * path has at `base` left out: a preserved file may be an edit of an
 * upstream file, and shared upstream lines say nothing about a copy.
 */
async function mirrorTextShapes(
  blobs: ReadonlyMap<string, string>,
  base: string,
  cwd: string
): Promise<MirrorText[]> {
  const bytes = await readSmallBlobs([...blobs.keys()], cwd);
  const upstreamLines = new Map<string, ReadonlySet<string>>();
  const texts: MirrorText[] = [];
  for (const [oid, file] of blobs) {
    const raw = bytes.get(oid);
    const decoded = raw === undefined ? null : decodeText(raw);
    const shape = decoded === null ? null : shapeOf(decoded);
    if (shape === null) continue;
    let known = upstreamLines.get(file);
    if (known === undefined) {
      const upstreamOid = await blobAt(base, file, cwd);
      const upstreamBytes =
        upstreamOid === null
          ? undefined
          : (await readSmallBlobs([upstreamOid], cwd)).get(upstreamOid);
      const upstreamText =
        upstreamBytes === undefined ? null : decodeText(upstreamBytes);
      known = new Set(
        upstreamText === null ? [] : normalizedLines(upstreamText)
      );
      upstreamLines.set(file, known);
    }
    const own = known;
    texts.push({
      path: file,
      fingerprint: shape.fingerprint,
      lines: new Set([...shape.lines].filter((line) => !own.has(line))),
    });
  }
  return texts;
}

/**
 * The path of the first mirror text that `shape` copies: the same normalized
 * text, or more than half of the mirror text's long lines (at least three).
 */
function findNearCopy(
  shape: TextShape,
  file: string,
  texts: readonly MirrorText[]
): string | null {
  for (const text of texts) {
    if (text.path === file) continue;
    if (text.fingerprint === shape.fingerprint) return text.path;
    if (text.lines.size < MIN_SHINGLE_LINES) continue;
    let shared = 0;
    for (const line of text.lines) if (shape.lines.has(line)) shared += 1;
    if (shared / text.lines.size > SHINGLE_SHARE) return text.path;
  }
  return null;
}

/**
 * Blob ids of the preserved files, the managed sync workflow and the
 * venfork config as the mirror holds or ever held them, mapped to the path
 * they were found at. A preserve entry that is a directory anywhere in that
 * history is refused as an invalid entry. A blob that is a version of the same path at `base` or in
 * its history is left out: it is upstream content, not mirror content.
 *
 * `refs` (and the venfork-config refs) are read at their tips, at their
 * reflog entries and in the history of both that `base` cannot reach.
 * Throws {@link VenforkError} when a ref has more than `historyCap` reflog
 * entries or that history more than `historyCap` commits, since older
 * versions could not be checked.
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
  const groups: HistoryGroup[] = [
    {
      refs,
      entries: [...new Set([...preserve, SYNC_WORKFLOW_PATH])],
    },
    {
      refs: ['refs/remotes/origin/venfork-config', 'refs/heads/venfork-config'],
      entries: [CONFIG_PATH],
    },
  ];
  const found: TreeBlob[] = [];
  for (const group of groups) {
    const trees = await mirrorTrees(group, base, cap, cwd);
    found.push(...(await blobsInTrees(trees, group.entries, preserve, cwd)));
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
  return { blobs, texts: await mirrorTextShapes(blobs, base, cwd) };
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
  /** `texts` from {@link collectMirrorBlobs}. */
  mirrorTexts: readonly MirrorText[];
  /** Output of `mirrorDenyList`. */
  denyList: readonly string[];
  /**
   * This mirror's upstream and public fork URLs (from the config and the
   * remotes). A config-shaped file naming one is refused even when
   * self-reference is allowed.
   */
  recordedUrls: readonly string[];
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
 * The first URL-derived term (one with a `/` or `:`) found in `bytes` as
 * UTF-8, UTF-16LE or UTF-16BE, ignoring ASCII case, at any offset. A bare
 * repo name is not searched: it matches too much binary data.
 */
function findTermInBytes(
  bytes: Buffer,
  terms: readonly string[]
): string | null {
  const haystack = bytes.toString('latin1').toLowerCase();
  for (const term of terms) {
    if (!/[/:]/.test(term)) continue;
    const lower = term.toLowerCase();
    const le = Buffer.from(lower, 'utf16le');
    const needles = [Buffer.from(lower, 'utf8'), le, Buffer.from(le).swap16()];
    for (const needle of needles) {
      if (haystack.includes(needle.toString('latin1'))) return term;
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
 *    `venfork`; in file content the bare repo name only after a host) or
 *    looks like a venfork `config.json` or holds `venfork:internal`
 *    marker text (also in author, committer and message, even with
 *    self-reference allowed); or when the venfork
 *    bot authored or committed the commit, or its author, committer or
 *    message contains a deny-list term. Text is read as UTF-8, or UTF-16
 *    when it starts with a byte order mark. Every file, text or binary, is
 *    also searched for the URL-derived terms as UTF-8, UTF-16LE and
 *    UTF-16BE bytes; compressed and UTF-32 content is not decoded.
 *  - {@link VenforkError} when a file is too large to read.
 *
 * Deleting a preserved path is allowed: no content leaves.
 *
 * @returns Every path some commit adds, modifies or retypes, in first-seen
 *   order, including paths a later commit deletes (history still holds them).
 */
export async function assertPublishableCommits(
  input: StageGateInput
): Promise<string[]> {
  const { branch, base, head, preserve, mirrorBlobs, denyList, cwd } = input;
  const list = await $({
    cwd,
  })`git rev-list --reverse ${base}..${head}`;
  const commits = list.stdout.split('\n').filter(Boolean);
  const upstreamBlobs = new Map<string, string | null>();
  const locationTerms = mirrorLocationTerms(denyList);
  const scanned = new Map<string, string | null>();
  const shapes = new Map<string, TextShape | null>();
  const publishedPaths = new Set<string>();

  for (const commit of commits) {
    const label = (input.originalOf.get(commit) ?? commit).slice(0, 12);

    const leaks: string[] = [];
    const published: TreeChange[] = [];
    for (const change of await treeChanges(commit, cwd)) {
      if (change.status === 'D') continue;
      published.push(change);
      publishedPaths.add(change.path);
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
        const textHit =
          text === null
            ? null
            : looksLikeVenforkConfig(text, input.recordedUrls)
              ? CONFIG_SIGNATURE
              : (findMarkerText(text) ??
                findDeniedText(text, locationTerms, { hostOnlyNames: true }));
        hit = textHit ?? findTermInBytes(bytes, locationTerms);
        scanned.set(change.newOid, hit);
        shapes.set(change.newOid, text === null ? null : shapeOf(text));
      }
      if (hit !== null) {
        throw new MirrorReferenceError(
          `commit ${label} file ${change.path}`,
          hit,
          `Remove it from ${change.path} and retry.`
        );
      }
      const shape = shapes.get(change.newOid);
      const source = shape
        ? findNearCopy(shape, change.path, input.mirrorTexts)
        : null;
      if (source !== null) {
        throw new StageLeakError(
          branch,
          [`${change.path} (near copy of ${source})`],
          label
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
      const marker = findMarkerText(value);
      if (marker !== null) {
        throw new MirrorReferenceError(
          `commit ${label} ${field}`,
          marker,
          'Rewrite the branch so no commit contains internal markers and retry.'
        );
      }
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
  return [...publishedPaths];
}

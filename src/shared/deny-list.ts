import { $ } from 'execa';
import { MirrorReferenceError } from '../errors.js';
import { parseRepoPath } from '../utils.js';

/** The bare word that also covers the internal markers and the bot identity. */
const SELF_REFERENCE_TERM = 'venfork';

/** Shortest mirror repo name used as a term; shorter names match too much. */
const MIN_NAME_TERM_LENGTH = 6;

/**
 * True when `VENFORK_ALLOW_SELF_REFERENCE=1`, for projects whose upstream
 * legitimately mentions venfork. It relaxes only the bare word, never a URL,
 * owner or repo name term.
 */
export function selfReferenceAllowed(): boolean {
  return process.env.VENFORK_ALLOW_SELF_REFERENCE === '1';
}

/**
 * Folds compatibility forms (a full-width colon) and drops invisible
 * characters (zero-width spaces, variation selectors, fillers) and combining
 * marks, so a disguised mention is still seen.
 *
 * @param text Text to fold.
 */
export function canonicalText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/gu, '');
}

/**
 * Text that must never reach the public fork or upstream because it points
 * back at the private mirror: origin's URL (as configured and without
 * `.git`), origin's GitHub `owner/name`, origin's repo name when it is at
 * least six characters and differs from upstream's, and the word `venfork`
 * (unless {@link selfReferenceAllowed}). Most specific first.
 *
 * @param cwd Mirror checkout whose `origin` remote is the private mirror.
 */
export async function mirrorDenyList(cwd: string): Promise<string[]> {
  const terms: string[] = [];
  const url = await $({ cwd, reject: false })`git remote get-url origin`;
  const raw = url.exitCode === 0 ? url.stdout.trim() : '';
  if (raw) {
    terms.push(raw);
    const bare = raw.replace(/\.git\/?$/, '');
    if (bare && bare !== raw) terms.push(bare);
    const repoPath = parseRepoPath(raw);
    if (repoPath) {
      terms.push(repoPath);
      const name = repoPath.split('/')[1] ?? '';
      const upstream = await $({
        cwd,
        reject: false,
      })`git remote get-url upstream`;
      const upstreamName =
        upstream.exitCode === 0
          ? (parseRepoPath(upstream.stdout.trim()).split('/')[1] ?? '')
          : '';
      if (
        name.length >= MIN_NAME_TERM_LENGTH &&
        name.toLowerCase() !== upstreamName.toLowerCase()
      ) {
        terms.push(name);
      }
    }
  }
  if (!selfReferenceAllowed()) terms.push(SELF_REFERENCE_TERM);
  return terms;
}

/**
 * The deny-list terms that point at the mirror itself, without the bare word
 * `venfork`. Published file content and names are scanned with these: a docs
 * file may mention the tool, but never the mirror.
 *
 * @param terms Output of {@link mirrorDenyList}.
 */
export function mirrorLocationTerms(terms: readonly string[]): string[] {
  return terms.filter((term) => term !== SELF_REFERENCE_TERM);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `github.com/`, `github.com:`, `git@<host>:`, `ssh://<host>/` or `http(s)://<host>/`. */
const HOST_PREFIX =
  '(?:github\\.com[:/]|git@[^\\s/:]+:|ssh://[^\\s/]+/|https?://[^\\s/]+/)';

/** Not followed by more of a repo name or by a file extension. */
const NAME_END = '(?![a-z0-9_-])(?!\\.[a-z0-9_])';

/**
 * Matches `name` as the repo segment of an `owner/name` or URL, optionally
 * with `.git`. After a host any path may follow (`/pull/3`); without one a
 * further `/` means a directory, so `src/backend/` and `src/backend.ts` do
 * not match. With `hostOnly`, only the hosted form matches.
 */
function repoNamePattern(name: string, hostOnly: boolean): RegExp {
  const repo = `[a-z0-9_.-]+[/:]${escapeRegExp(name)}(?:\\.git)?`;
  const hosted = `${HOST_PREFIX}${repo}${NAME_END}`;
  return new RegExp(hostOnly ? hosted : `${hosted}|${repo}(?!/)${NAME_END}`);
}

/** Options for {@link findDeniedText}. */
export interface FindDeniedTextOptions {
  /**
   * Match a bare repo name term only after a host. For file content, where
   * a package or directory of the same name is common.
   */
  hostOnlyNames?: boolean;
}

/**
 * Returns the first deny-list term found in `text` (case-insensitive, with
 * text and terms both passed through {@link canonicalText}), or null when
 * the text is clean. A term with no `/`, `:` or `@` other than `venfork` is
 * a bare repo name and matches only as the repo of an `owner/name` or URL.
 * Every other term but `venfork` must not run on into more of a repo name:
 * `acme/widget-public` does not match the term `acme/widget`.
 *
 * @param text Text bound for the public side.
 * @param terms Output of {@link mirrorDenyList}.
 * @param options Matching options.
 */
export function findDeniedText(
  text: string,
  terms: readonly string[],
  options: FindDeniedTextOptions = {}
): string | null {
  const folded = canonicalText(text).toLowerCase();
  for (const term of terms) {
    const needle = canonicalText(term).toLowerCase();
    if (!needle) continue;
    let found: boolean;
    if (term === SELF_REFERENCE_TERM) {
      found = folded.includes(needle);
    } else if (!/[/:@]/.test(term)) {
      found = repoNamePattern(needle, options.hostOnlyNames === true).test(
        folded
      );
    } else {
      found = new RegExp(`${escapeRegExp(needle)}(?![a-z0-9_-])`).test(folded);
    }
    if (found) return term;
  }
  return null;
}

/**
 * Throws {@link MirrorReferenceError} when `text` contains a deny-list term.
 *
 * @param text Text bound for the public side.
 * @param where What the text is, for the error (e.g. `the upstream PR body`).
 * @param terms Output of {@link mirrorDenyList}.
 */
export function assertNoMirrorReference(
  text: string,
  where: string,
  terms: readonly string[]
): void {
  const matched = findDeniedText(text, terms);
  if (matched !== null) {
    throw new MirrorReferenceError(
      where,
      matched,
      `Remove '${matched}' from ${where} and retry.`
    );
  }
}

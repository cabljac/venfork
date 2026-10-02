import { $ } from 'execa';
import { MirrorReferenceError } from '../errors.js';
import { parseRepoPath } from '../utils.js';

/**
 * Folds compatibility forms (a full-width colon) and drops invisible format
 * characters (zero-width spaces), so a disguised mention is still seen.
 *
 * @param text Text to fold.
 */
export function canonicalText(text: string): string {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

/**
 * Text that must never reach the public fork or upstream because it points
 * back at the private mirror: origin's URL (as configured and without
 * `.git`), origin's GitHub `owner/name`, and the word `venfork` (which also
 * covers the internal markers and the bot identity). Most specific first.
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
    if (repoPath) terms.push(repoPath);
  }
  terms.push('venfork');
  return terms;
}

/**
 * Returns the first deny-list term found in `text` (case-insensitive, after
 * {@link canonicalText}), or null when the text is clean.
 *
 * @param text Text bound for the public side.
 * @param terms Output of {@link mirrorDenyList}.
 */
export function findDeniedText(
  text: string,
  terms: readonly string[]
): string | null {
  const folded = canonicalText(text).toLowerCase();
  for (const term of terms) {
    if (folded.includes(term.toLowerCase())) return term;
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

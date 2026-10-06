import { $ } from 'execa';
import { RedactionError } from '../errors.js';
import { canonicalText, selfReferenceAllowed } from './deny-list.js';

/** Internal review PR fields read from the private mirror via gh. */
export interface InternalPrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
}

const HTML_COMMENT_RE = /<!--[\s\S]*?--!?>/g;
const MARKER_RE = /^\s*(\/)?\s*venfork\s*:\s*internal\b/i;

/** Text shaped like a marker, whatever wraps it. */
const MARKER_TEXT_RE = /venfork\s*:\s*internal/i;

/**
 * The marker-shaped text (`venfork:internal`, folded to its canonical form)
 * in `text`, or null. Unlike the bare word `venfork`, this is refused in
 * published content even when self-reference is allowed.
 *
 * @param text Text bound for the public side.
 */
export function findMarkerText(text: string): string | null {
  return canonicalText(text).match(MARKER_TEXT_RE)?.[0] ?? null;
}

/** A comment body that reads like a broken marker (`venfork:intenral`, `venfork internal`). */
const MARKER_SHAPED_COMMENT_RE = /venfork\s*:|venfork\W*internal/i;

/** Text around the first canonical match of `pattern`, for error messages. */
function snippetOf(text: string, pattern: RegExp): string | null {
  const folded = canonicalText(text);
  const at = folded.search(pattern);
  if (at === -1) return null;
  return folded.slice(Math.max(0, at - 20), at + 40);
}

interface RedactionMarker {
  type: 'open' | 'close';
  start: number;
  end: number;
}

/**
 * Removes properly-nested `<!-- venfork:internal -->...<!-- /venfork:internal -->`
 * blocks from `body`. Scans every HTML comment (`<!--` to the first `-->` or
 * `--!>`), classifies its body as an open or close marker, and tracks depth,
 * so every char between the outermost open and its matching close is dropped
 * (including any inner pairs).
 *
 * Markers match case-insensitively, with optional whitespace around the
 * `/` and `:` and any note after the keyword
 * (`<!-- VENFORK: internal (draft) -->`).
 *
 * Fails closed with {@link RedactionError}:
 *  - an unmatched close marker,
 *  - a comment that mentions venfork but is not a marker (a misspelled
 *    marker such as `venfork:intenral`; with
 *    `VENFORK_ALLOW_SELF_REFERENCE=1`, only a comment shaped like one,
 *    with `venfork:` or `venfork` then `internal`), or
 *  - any `venfork` mention left anywhere after stripping (with
 *    `VENFORK_ALLOW_SELF_REFERENCE=1`, only text shaped like a marker,
 *    such as `[venfork:internal]`).
 *
 * An unmatched open marker drops everything to end-of-input.
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function stripInternalBlocks(body: string): string {
  const markers: RedactionMarker[] = [];
  for (const m of body.matchAll(HTML_COMMENT_RE)) {
    const comment = m[0];
    const inner = canonicalText(
      comment.slice(4, comment.length - (comment.endsWith('--!>') ? 4 : 3))
    );
    const marker = inner.match(MARKER_RE);
    if (marker) {
      const start = m.index ?? 0;
      markers.push({
        type: marker[1] ? 'close' : 'open',
        start,
        end: start + comment.length,
      });
    } else if (
      (selfReferenceAllowed() ? MARKER_SHAPED_COMMENT_RE : /venfork/i).test(
        inner
      )
    ) {
      throw new RedactionError(comment);
    }
  }

  let result = '';
  let cursor = 0;
  let depth = 0;
  for (const marker of markers) {
    if (marker.type === 'open') {
      if (depth === 0) {
        result += body.slice(cursor, marker.start);
      }
      depth += 1;
      cursor = marker.end;
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      cursor = marker.end;
    } else {
      throw new RedactionError(body.slice(marker.start, marker.end));
    }
  }
  if (depth === 0) {
    result += body.slice(cursor);
  }
  const leftover = snippetOf(
    result,
    selfReferenceAllowed() ? MARKER_TEXT_RE : /venfork/i
  );
  if (leftover !== null) {
    throw new RedactionError(leftover);
  }
  return result;
}

/**
 * Looks up the most relevant internal PR for `branch` on the private mirror.
 * When `pinnedNumber` is set, fetches that exact PR via `gh pr view` (skips
 * the list lookup). Otherwise prefers the most recent open PR, then the most
 * recent of any state. Returns null if none exists or the lookup fails — the
 * caller falls back to a generated synthetic body.
 */
export async function findInternalPr(
  mirrorRepoPath: string,
  branch: string,
  cwd: string,
  pinnedNumber?: number
): Promise<InternalPrInfo | null> {
  if (pinnedNumber !== undefined) {
    const result = await $({
      cwd,
      reject: false,
    })`gh pr view ${pinnedNumber} --repo ${mirrorRepoPath} --json number,url,title,body`;
    if (result.exitCode !== 0) {
      return null;
    }
    try {
      return JSON.parse(result.stdout) as InternalPrInfo;
    } catch {
      return null;
    }
  }
  // Prefer an open PR; if none, take the most recent of any state.
  // Pass each flag/value as a separate execa interpolation — passing
  // `--state open` as a single string makes execa treat it as one arg
  // and gh silently filters wrong (returns zero results).
  for (const state of ['open', 'all'] as const) {
    const result = await $({
      cwd,
      reject: false,
    })`gh pr list --repo ${mirrorRepoPath} --head ${branch} --state ${state} --json number,url,title,body --limit 1`;
    if (result.exitCode !== 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(result.stdout) as InternalPrInfo[];
      if (parsed.length > 0) {
        return parsed[0];
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Renders an internal PR/issue body for upstream by stripping
 * `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks via a
 * depth-tracking pass (see `stripInternalBlocks`).
 *
 * The private mirror must stay invisible to upstream: no back-link to the
 * internal PR/issue and no hint that one exists. The upstream maintainer sees
 * only the public-facing body.
 */
export function translateInternalBody(body: string): string {
  return stripInternalBlocks(body).trim();
}

/**
 * Renders an internal PR/issue title for upstream: internal blocks are
 * stripped exactly as in bodies, so a title is published only after
 * redaction.
 */
export function translateInternalTitle(title: string): string {
  return stripInternalBlocks(title).trim();
}

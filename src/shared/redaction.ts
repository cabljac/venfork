import { $ } from 'execa';

/** Internal review PR fields read from the private mirror via gh. */
export interface InternalPrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
}

const VENFORK_INTERNAL_OPEN_RE = /<!--\s*venfork:internal\s*-->/g;
const VENFORK_INTERNAL_CLOSE_RE = /<!--\s*\/venfork:internal\s*-->/g;

interface RedactionMarker {
  type: 'open' | 'close';
  start: number;
  end: number;
}

/**
 * Removes properly-nested `<!-- venfork:internal -->...<!-- /venfork:internal -->`
 * blocks from `body`. Walks markers in document order and tracks depth, so
 * nested pairs collapse correctly: every char between the outermost open and
 * its matching close is dropped (including any inner pairs).
 *
 * Edge cases:
 *  - Unmatched close marker: dropped, surrounding content preserved.
 *  - Unmatched open marker: content from that open to end-of-input is
 *    dropped (defensive — a missing close shouldn't leak intended-private
 *    content upstream).
 *  - Whitespace inside the markers is tolerated (`<!-- venfork:internal -->`
 *    and `<!--venfork:internal-->` both match).
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function stripInternalBlocks(body: string): string {
  const markers: RedactionMarker[] = [];
  // Reset lastIndex on the global regexes — they're module-scoped and would
  // otherwise carry state across calls.
  VENFORK_INTERNAL_OPEN_RE.lastIndex = 0;
  VENFORK_INTERNAL_CLOSE_RE.lastIndex = 0;

  for (
    let m = VENFORK_INTERNAL_OPEN_RE.exec(body);
    m !== null;
    m = VENFORK_INTERNAL_OPEN_RE.exec(body)
  ) {
    markers.push({ type: 'open', start: m.index, end: m.index + m[0].length });
  }
  for (
    let m = VENFORK_INTERNAL_CLOSE_RE.exec(body);
    m !== null;
    m = VENFORK_INTERNAL_CLOSE_RE.exec(body)
  ) {
    markers.push({ type: 'close', start: m.index, end: m.index + m[0].length });
  }
  markers.sort((a, b) => a.start - b.start);

  let result = '';
  let cursor = 0;
  let depth = 0;
  for (const marker of markers) {
    if (marker.type === 'open') {
      if (depth === 0) {
        // Surfacing into a new redacted block — emit content up to here.
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
      // Unmatched close marker. Keep the content before it; drop the
      // marker itself.
      result += body.slice(cursor, marker.start);
      cursor = marker.end;
    }
  }
  if (depth === 0) {
    result += body.slice(cursor);
  }
  // depth > 0 here means an unclosed open marker — content from the
  // unmatched open to end-of-input is intentionally dropped.
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

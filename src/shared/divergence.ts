import { $ } from 'execa';
import { normalizePreservePath } from '../config.js';
import type { SyncDivergenceError } from '../errors.js';
import { isManagedCommit } from './managed-commit.js';

/**
 * Lists the file paths changed by a single commit. Returns an empty array on
 * git error or for empty commits. Shared by `isPreservedCommit` and the
 * divergence-check file collection — both want the same name-only output.
 *
 * Uses `diff-tree -m --first-parent` instead of `git show` so merge commits
 * are diffed against their *first parent* (everything the merge brought in
 * from the side branch), not the default combined-diff (`--cc`) which only
 * surfaces conflict-resolution files. Without this, a clean merge that
 * touches a preserved file would show zero changed files — which would
 * make `isPreservedCommit` return false and abort sync on a benign merge.
 */
export async function changedFilesInCommit(
  ref: string,
  cwd?: string
): Promise<string[]> {
  const cwdOpt = cwd ? { cwd } : {};
  const result = await $({
    ...cwdOpt,
    reject: false,
  })`git diff-tree -r --no-commit-id --name-only -m --first-parent ${ref}`;
  if (result.exitCode !== 0) return [];
  // Strip only a trailing CR (CRLF on Windows checkouts), not arbitrary
  // whitespace — git path entries can in principle contain leading/trailing
  // spaces, and `trim()` would silently mangle them. Empty lines after the
  // CR strip are dropped.
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');
}

/**
 * Returns true when every file in `changedFiles` is in the preserve allowlist.
 * Used by sync's divergence check to allow user-authored mirror-only commits
 * (e.g. a caller workflow) ahead of upstream — as long as every changed file
 * is something the user has explicitly opted into preserving.
 *
 * Takes pre-computed `changedFiles` AND a pre-built `allowed` Set so the
 * caller can amortize both the `git diff-tree` invocation and the Set
 * construction across multiple commits. Pure / synchronous: no I/O.
 */
export function isPreservedCommit(
  changedFiles: string[],
  allowed: Set<string>
): boolean {
  if (allowed.size === 0) return false;
  if (changedFiles.length === 0) return false;
  return changedFiles.every((file) => allowed.has(file));
}

/** Commits on `<remote>/<defaultBranch>` that upstream does not have. */
export interface DivergenceResult {
  count: number;
  files: string[];
}

/**
 * Counts user-authored commits on `<remote>/<defaultBranch>` that are not in
 * `upstream/<defaultBranch>`, skipping the venfork-managed commit and, when
 * `allowPreserved` is set, commits that only touch preserved paths. A missing
 * remote branch counts as no divergence; any other git failure throws.
 */
export async function checkDivergence(args: {
  remote: string;
  defaultBranch: string;
  allowPreserved: boolean;
  preserveAllowed: Set<string>;
  cwd?: string;
}): Promise<DivergenceResult> {
  const { remote, defaultBranch, allowPreserved, preserveAllowed, cwd } = args;
  const cwdOpt = cwd ? { cwd } : {};
  const remoteRef = await $({
    ...cwdOpt,
    reject: false,
  })`git rev-parse --verify ${`${remote}/${defaultBranch}`}`;
  if (remoteRef.exitCode !== 0) {
    // First sync: the remote has no default branch yet.
    return { count: 0, files: [] };
  }
  const result = await $({
    ...cwdOpt,
  })`git rev-list upstream/${defaultBranch}..${remote}/${defaultBranch}`;
  const divergentCommits = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let count = 0;
  const files = new Set<string>();
  for (const commit of divergentCommits) {
    if (await isManagedCommit(commit, cwd)) continue;
    // Compute the changed files once - both the preserve check and the
    // divergence-error file aggregation want the same list, and
    // `git diff-tree` isn't free.
    const commitFiles = await changedFilesInCommit(commit, cwd);
    if (allowPreserved && isPreservedCommit(commitFiles, preserveAllowed)) {
      continue;
    }
    count += 1;
    for (const file of commitFiles) {
      files.add(file);
    }
  }
  return { count, files: Array.from(files).sort() };
}

/**
 * Human-readable explanation of a {@link SyncDivergenceError}: which remotes
 * diverged, the files involved, and how to unblock sync. `maxFiles` caps
 * each file list and appends "...and N more".
 */
export function formatDivergenceReport(
  error: SyncDivergenceError,
  options: { maxFiles?: number } = {}
): string {
  const { defaultBranch, origin, publicFork } = error;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const more = (total: number): string =>
    total > maxFiles ? `\n  ...and ${total - maxFiles} more` : '';
  const warnings: string[] = [];
  if (origin.count > 0) {
    warnings.push(
      `  • origin/${defaultBranch} has ${origin.count} commit(s) not in upstream`
    );
  }
  if (publicFork.count > 0) {
    warnings.push(
      `  • public/${defaultBranch} has ${publicFork.count} commit(s) not in upstream`
    );
  }

  // When origin diverges, surface the changed files and a concrete
  // `venfork preserve add ...` hint. Most likely cause is a mirror-only
  // file the user committed directly (or one whose preserve entry was
  // just removed) — both cases resolve with `preserve add`. Public
  // divergence does NOT get this hint: preserve doesn't apply to public,
  // so suggesting it would mislead.
  const sections: string[] = [warnings.join('\n')];
  if (origin.files.length > 0) {
    sections.push(
      `Files changed by divergent commits on origin/${defaultBranch}:\n${origin.files
        .slice(0, maxFiles)
        .map((f) => `  • ${f}`)
        .join('\n')}${more(origin.files.length)}`
    );
    // Only suggest preserve for paths the validator would actually
    // accept — otherwise the copy/paste command line would fail.
    // If every divergent path is invalid for preserve, suppress the hint
    // entirely (rebase/force-sync below still apply).
    const validForPreserve: string[] = [];
    const invalidForPreserve: string[] = [];
    for (const file of origin.files) {
      if (normalizePreservePath(file) !== null) {
        validForPreserve.push(file);
      } else {
        invalidForPreserve.push(file);
      }
    }
    if (validForPreserve.length > 0) {
      sections.push(
        `If these are mirror-only files you want to keep across sync, add them to preserve:\n  venfork preserve add ${validForPreserve.slice(0, maxFiles).join(' ')}${more(validForPreserve.length)}`
      );
      if (invalidForPreserve.length > 0) {
        sections.push(
          `(skipped from the hint — paths can't be expressed in the preserve allowlist: ${invalidForPreserve.join(', ')})`
        );
      }
    }
  }
  sections.push(
    `Otherwise:\n- Rebase or cherry-pick to a feature branch before running sync\n- Force-sync (DESTRUCTIVE — permanently discards the commits): git push origin upstream/${defaultBranch}:refs/heads/${defaultBranch} -f`
  );
  return sections.join('\n\n');
}

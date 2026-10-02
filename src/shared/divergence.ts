import { $ } from 'execa';
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

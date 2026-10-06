import { $ } from 'execa';
import { normalizePreservePath } from '../config.js';
import type { SyncDivergenceError } from '../errors.js';
import {
  inspectManagedCommit,
  isWeakManagedKind,
  type ManagedCommitKind,
  type WorkflowPolicy,
} from './managed-commit.js';

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
  })`git diff-tree -r -z --no-commit-id --name-only -m --first-parent ${ref}`;
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\0').filter((entry) => entry !== '');
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

/** A commit skipped as venfork-managed on a weak signal (not the trailer). */
export interface DroppedManagedCommit {
  commit: string;
  kind: ManagedCommitKind;
  /** Paths a `stale-trailer` commit changes that replacing it discards. */
  staleFiles: string[];
}

/** Commits on a mirror tip that upstream does not have. */
export interface DivergenceResult {
  count: number;
  files: string[];
  /** Commits skipped as managed on a signal other than the trailer. */
  weakManaged: DroppedManagedCommit[];
}

/** Blob id of `path` at `commit`, or null when the path is not a blob there. */
async function blobAt(
  commit: string,
  file: string,
  cwd?: string
): Promise<string | null> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git rev-parse --verify --quiet ${`${commit}:${file}`}`;
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Counts user-authored commits in `base..tip`, skipping the venfork-managed
 * commit and, when `allowPreserved` is set, commits that only touch
 * preserved paths whose content the managed commit will carry forward. A
 * preserved path that upstream also has is upstream's: when `tip` holds a
 * different blob for it, the commit that changed it counts as divergence,
 * since a re-stamp would discard that change.
 *
 * `base` and `tip` are commit ids, never ref names, so the range checked is
 * exactly the range the caller later leases on. An empty `tip` (no remote
 * branch yet) counts as no divergence; any git failure throws.
 */
export async function checkDivergence(args: {
  base: string;
  tip: string;
  allowPreserved: boolean;
  preserveAllowed: Set<string>;
  /** Workflow lists the managed commit must match; omitted accepts any workflow deletion. */
  workflowPolicy?: WorkflowPolicy;
  cwd?: string;
}): Promise<DivergenceResult> {
  const { base, tip, allowPreserved, preserveAllowed, workflowPolicy, cwd } =
    args;
  if (!tip) {
    return { count: 0, files: [], weakManaged: [] };
  }
  const cwdOpt = cwd ? { cwd } : {};
  const result = await $({
    ...cwdOpt,
  })`git rev-list ${`${base}..${tip}`}`;
  const divergentCommits = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let count = 0;
  const files = new Set<string>();
  const weakManaged: DroppedManagedCommit[] = [];
  const upstreamOwned = new Map<string, boolean>();
  for (const commit of divergentCommits) {
    const managed = await inspectManagedCommit(
      commit,
      cwd,
      preserveAllowed,
      workflowPolicy
    );
    if (managed !== null) {
      if (isWeakManagedKind(managed.kind)) {
        weakManaged.push({
          commit,
          kind: managed.kind,
          staleFiles: managed.staleFiles,
        });
      }
      continue;
    }
    // Compute the changed files once - both the preserve check and the
    // divergence-error file aggregation want the same list, and
    // `git diff-tree` isn't free.
    const commitFiles = await changedFilesInCommit(commit, cwd);
    if (allowPreserved && isPreservedCommit(commitFiles, preserveAllowed)) {
      let discarded = false;
      for (const file of commitFiles) {
        if (!upstreamOwned.has(file)) {
          const upstreamBlob = await blobAt(base, file, cwd);
          const tipBlob =
            upstreamBlob === null ? null : await blobAt(tip, file, cwd);
          upstreamOwned.set(
            file,
            upstreamBlob !== null &&
              tipBlob !== null &&
              tipBlob !== upstreamBlob
          );
        }
        if (upstreamOwned.get(file)) discarded = true;
      }
      if (!discarded) continue;
    }
    count += 1;
    for (const file of commitFiles) {
      files.add(file);
    }
  }
  return { count, files: Array.from(files).sort(), weakManaged };
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

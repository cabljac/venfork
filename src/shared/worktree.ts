import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';

/**
 * Runs `fn` inside a temporary detached worktree of `repoDir` checked out at
 * `ref`. The worktree and its directory are always removed afterwards.
 *
 * @param repoDir Repository that owns the worktree.
 * @param ref Commit-ish to check out.
 * @param prefix Temp directory name prefix (e.g. `venfork-sync-`).
 * @param fn Receives the worktree path; its result is returned.
 */
export async function withDetachedWorktree<T>(
  repoDir: string,
  ref: string,
  prefix: string,
  fn: (worktreeDir: string) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await $({ cwd: repoDir })`git worktree add --detach ${tempDir} ${ref}`;
    return await fn(tempDir);
  } finally {
    await $({
      cwd: repoDir,
      reject: false,
    })`git worktree remove --force ${tempDir}`;
    await rm(tempDir, { recursive: true, force: true });
  }
}

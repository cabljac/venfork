import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';

/**
 * Runs `fn` inside a temporary detached worktree of `repoDir` checked out at
 * `ref`. The checkout runs with an empty hooks directory, so the clone's
 * hooks cannot change the worktree. The worktree and its directory are
 * always removed afterwards.
 *
 * @param repoDir Repository that owns the worktree.
 * @param ref Commit-ish to check out.
 * @param prefix Temp directory name prefix (e.g. `venfork-sync-`).
 * @param fn Receives the worktree path and the empty hooks directory to
 *   pass as `core.hooksPath` to later commands; its result is returned.
 */
export async function withDetachedWorktree<T>(
  repoDir: string,
  ref: string,
  prefix: string,
  fn: (worktreeDir: string, hooksDir: string) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const hooksDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-hooks-'));
  try {
    await $({
      cwd: repoDir,
    })`git -c core.hooksPath=${hooksDir} worktree add --detach ${tempDir} ${ref}`;
    return await fn(tempDir, hooksDir);
  } finally {
    await $({
      cwd: repoDir,
      reject: false,
    })`git worktree remove --force ${tempDir}`;
    await rm(tempDir, { recursive: true, force: true });
    await rm(hooksDir, { recursive: true, force: true });
  }
}

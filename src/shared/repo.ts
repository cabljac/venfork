import { $ } from 'execa';
import { parseRepoPath } from '../utils.js';

/** `owner/name` of the `origin` remote, or null when it cannot be resolved. */
export async function findMirrorRepoPath(cwd: string): Promise<string | null> {
  const result = await $({
    cwd,
    reject: false,
  })`git remote get-url origin`;
  if (result.exitCode !== 0) return null;
  const path = parseRepoPath(result.stdout.trim());
  return path || null;
}

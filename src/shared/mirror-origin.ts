import { $ } from 'execa';
import { githubUrlRepoPath } from '../utils.js';

/**
 * `owner/name` of the mirror's origin on GitHub, or null when origin is not
 * a GitHub repository. The URL git resolves through `insteadOf` wins, so
 * shorthand such as `gh:owner/name` names its real owner; the configured URL
 * is the fallback for an origin that resolves to a local path.
 *
 * @param cwd Mirror checkout.
 */
export async function mirrorOriginPath(cwd: string): Promise<string | null> {
  const resolved = await $({ cwd, reject: false })`git remote get-url origin`;
  if (resolved.exitCode !== 0) return null;
  const resolvedPath = githubUrlRepoPath(String(resolved.stdout));
  if (resolvedPath) return resolvedPath;
  const raw = await $({
    cwd,
    reject: false,
  })`git config --get remote.origin.url`;
  if (raw.exitCode !== 0) return null;
  return githubUrlRepoPath(String(raw.stdout)) || null;
}

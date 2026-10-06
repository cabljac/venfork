import { $ } from 'execa';
import { AuthenticationError, GitError } from './errors.js';
import { netExec, netFailureReason } from './shared/net.js';

/**
 * Checks if GitHub CLI is authenticated
 *
 * @returns true if authenticated, false otherwise
 */
export async function checkGhAuth(): Promise<boolean> {
  try {
    const result = await $({ reject: false })`gh auth status`;
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Throws `AuthenticationError` unless the GitHub CLI is authenticated.
 * Called by the CLI dispatcher for commands that talk to GitHub through gh.
 */
export async function ensureGhAuth(): Promise<void> {
  if (!(await checkGhAuth())) {
    throw new AuthenticationError();
  }
}

/**
 * Gets the current git branch name
 *
 * @returns Current branch name, or empty string if not in a git repo
 */
export async function getCurrentBranch(): Promise<string> {
  try {
    const result = await $({ reject: false })`git branch --show-current`;
    return result.stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Gets the authenticated GitHub username
 *
 * @returns GitHub username, or empty string if not authenticated
 */
export async function getGitHubUsername(): Promise<string> {
  try {
    const result = await $`gh api user --jq .login`;
    return result.stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Checks if the current directory is a git repository
 *
 * @returns true if in a git repo, false otherwise
 */
export async function isGitRepository(): Promise<boolean> {
  try {
    const result = await $({ reject: false })`git rev-parse --git-dir`;
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Reads every git remote's fetch and push URL with `git remote get-url`
 * (and `--push`), so URLs and paths containing spaces come back intact.
 *
 * @param cwd Repository to read; defaults to the current directory.
 * @returns Object mapping remote names to their fetch/push URLs; empty when
 *   the directory is not a repository.
 */
export async function getRemotes(
  cwd?: string
): Promise<Record<string, { fetch: string; push: string }>> {
  const cwdOpt = cwd ? { cwd } : {};
  try {
    const list = await $({ ...cwdOpt, reject: false })`git remote`;
    if (list.exitCode !== 0) {
      return {};
    }
    const remotes: Record<string, { fetch: string; push: string }> = {};
    for (const name of list.stdout.split('\n').map((line) => line.trim())) {
      if (!name) continue;
      const fetchUrl = await $({
        ...cwdOpt,
        reject: false,
      })`git remote get-url ${name}`;
      const pushUrl = await $({
        ...cwdOpt,
        reject: false,
      })`git remote get-url --push ${name}`;
      remotes[name] = {
        fetch: fetchUrl.exitCode === 0 ? fetchUrl.stdout.trim() : '',
        push: pushUrl.exitCode === 0 ? pushUrl.stdout.trim() : '',
      };
    }
    return remotes;
  } catch {
    return {};
  }
}

/**
 * Checks if a specific git remote exists
 *
 * @param name - Remote name to check
 * @returns true if remote exists, false otherwise
 */
export async function hasRemote(name: string): Promise<boolean> {
  try {
    const result = await $({ reject: false })`git remote get-url ${name}`;
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Returns true if GitHub repo `owner/name` exists and is visible to the authenticated `gh` user.
 */
export async function ghRepoExists(fullName: string): Promise<boolean> {
  const result = await $({ reject: false })`gh repo view ${fullName}`;
  return result.exitCode === 0;
}

/**
 * Returns true when `repoFullName` exists and is a fork of `upstreamFullName`.
 */
export async function ghRepoIsForkOf(
  repoFullName: string,
  upstreamFullName: string
): Promise<boolean> {
  const result = await $({
    reject: false,
  })`gh repo view ${repoFullName} --json isFork,parent --jq '.isFork and .parent.nameWithOwner == "${upstreamFullName}"'`;
  if (result.exitCode !== 0) {
    return false;
  }
  return result.stdout.trim() === 'true';
}

/**
 * Gets the default branch for a remote
 *
 * @param remote - Remote name (default: 'upstream')
 * @param cwd - Optional working directory (must be a git repo with that remote)
 * `git remote set-head -a` needs the branch already fetched, so callers
 * fetch `remote` first.
 *
 * @returns Default branch name (e.g., 'main', 'master', 'develop')
 * @throws GitError naming the remote when neither `set-head -a` nor an
 *   existing `refs/remotes/<remote>/HEAD` yields a branch.
 *
 * @example
 * await getDefaultBranch('upstream') // "main"
 * await getDefaultBranch('origin') // "master"
 */
export async function getDefaultBranch(
  remote = 'upstream',
  cwd?: string
): Promise<string> {
  const setHead = await netExec(cwd, {
    bufferOutput: true,
  })`git remote set-head ${remote} -a`;

  const result = await $({
    ...(cwd ? { cwd } : {}),
    reject: false,
  })`git symbolic-ref refs/remotes/${remote}/HEAD`;
  const match =
    result.exitCode === 0
      ? result.stdout.trim().match(/^refs\/remotes\/[^/]+\/(.+)$/)
      : null;
  if (match?.[1]) return match[1];

  const reason =
    setHead.exitCode !== 0
      ? netFailureReason(setHead)
      : result.stderr?.trim() || result.stdout.trim() || 'no remote HEAD';
  throw new GitError(
    `cannot tell the default branch of remote '${remote}' (${reason}). Run \`git fetch ${remote}\` and retry.`,
    `git remote set-head ${remote} -a`
  );
}

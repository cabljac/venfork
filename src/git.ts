import { $ } from 'execa';

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
 * Gets all git remotes with their URLs
 *
 * @returns Object mapping remote names to their fetch/push URLs
 */
export async function getRemotes(): Promise<
  Record<string, { fetch: string; push: string }>
> {
  try {
    const result = await $({ reject: false })`git remote -v`;
    if (result.exitCode !== 0) {
      return {};
    }

    const remotes: Record<string, { fetch: string; push: string }> = {};
    const lines = result.stdout.trim().split('\n');

    for (const line of lines) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
      if (match) {
        const [, name, url, type] = match;
        if (!remotes[name]) {
          remotes[name] = { fetch: '', push: '' };
        }
        if (type === 'fetch') {
          remotes[name].fetch = url;
        } else if (type === 'push') {
          remotes[name].push = url;
        }
      }
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
 * Gets the default branch for a remote
 *
 * @param remote - Remote name (default: 'upstream')
 * @returns Default branch name (e.g., 'main', 'master', 'develop')
 *
 * @example
 * await getDefaultBranch('upstream') // "main"
 * await getDefaultBranch('origin') // "master"
 */
export async function getDefaultBranch(remote = 'upstream'): Promise<string> {
  try {
    // First, try to update the remote HEAD to detect the default branch
    await $({ reject: false })`git remote set-head ${remote} -a`;

    // Get the symbolic ref for the remote HEAD
    const result = await $({
      reject: false,
    })`git symbolic-ref refs/remotes/${remote}/HEAD`;

    if (result.exitCode === 0) {
      // Output is like "refs/remotes/upstream/main"
      const match = result.stdout.trim().match(/refs\/remotes\/[^/]+\/(.+)$/);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    // Fall through to default
  }

  // Fallback to 'main' if detection fails
  return 'main';
}

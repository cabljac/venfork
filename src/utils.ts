export const DEFAULT_REPO_NAME = 'my-mirror';

/**
 * If `input` is GitHub `owner/repo` shorthand, returns `git@github.com:owner/repo.git`.
 * Otherwise returns `input` trimmed (full SSH/HTTPS URLs are left as-is, aside from trim).
 */
export function normalizeGitHubRepoInput(input: string): string {
  const t = input.trim();
  if (!t) {
    return t;
  }
  if (/^https:\/\/github\.com\//i.test(t) || /^git@github\.com:/i.test(t)) {
    return t;
  }
  if (
    !t.includes('://') &&
    !t.includes('@') &&
    /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(t)
  ) {
    const base = t.endsWith('.git') ? t.slice(0, -4) : t;
    return `git@github.com:${base}.git`;
  }
  // Return empty string for unrecognised formats (e.g. bare github.com/owner/repo)
  // so callers can treat the result as invalid.
  return '';
}

/**
 * Extracts repository name from a GitHub URL
 *
 * @param url - GitHub repository URL (SSH or HTTPS)
 * @returns Repository name (e.g., "react" from "github.com/facebook/react")
 *
 * @example
 * parseRepoName("git@github.com:facebook/react.git") // "react"
 * parseRepoName("https://github.com/vercel/next.js.git") // "next.js"
 */
export function parseRepoName(url: string): string {
  // Handle various GitHub URL formats
  const match = url.match(/(?:github\.com[:/])(?:.+\/)?(.+?)(?:\.git)?$/);
  return match?.[1] || DEFAULT_REPO_NAME;
}

/**
 * Extracts owner/repo path from a GitHub URL
 *
 * @param url - GitHub repository URL (SSH or HTTPS)
 * @returns Owner and repository path (e.g., "facebook/react"), or an empty
 *   string when the input is not exactly `owner/repo` on github.com
 *
 * @example
 * parseRepoPath("git@github.com:facebook/react.git") // "facebook/react"
 * parseRepoPath("https://github.com/vercel/next.js.git") // "vercel/next.js"
 */
export function parseRepoPath(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return '';
  }

  // Accept already-short owner/repo input too, so callers that need
  // a GH repo path stay robust even if normalization is skipped.
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:\.git)?$/.test(trimmed)) {
    return trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  }

  const match = trimmed.match(
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?(?:www\.|ssh\.)?github\.com(?::\d+)?[:/](.+)$/i
  );
  if (!match) return '';
  const repoPath = match[1].replace(/\/+$/, '').replace(/\.git$/, '');
  return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoPath) ? repoPath : '';
}

/** Transport for github.com remotes, as `gh config get git_protocol` reports it. */
export type GitProtocol = 'https' | 'ssh';

const GITHUB_URL_PREFIX =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?(?:www\.|ssh\.)?github\.com(?::\d+)?[:/]/i;

/**
 * `owner/repo` of a github.com URL, or an empty string for anything else,
 * including bare `owner/repo` shorthand and local paths.
 *
 * @param url Remote URL.
 */
export function githubUrlRepoPath(url: string): string {
  return GITHUB_URL_PREFIX.test(url.trim()) ? parseRepoPath(url) : '';
}

/**
 * Rewrites a github.com repo URL to `protocol`
 * (`https://github.com/<owner>/<repo>.git` or `git@github.com:<owner>/<repo>.git`).
 * Any other URL, a bare `owner/repo` or a local path, is returned unchanged.
 *
 * @param url Remote URL as recorded.
 * @param protocol Transport to use, or null to keep `url` as is.
 */
export function githubUrlForProtocol(
  url: string,
  protocol: GitProtocol | null
): string {
  if (!protocol || !GITHUB_URL_PREFIX.test(url.trim())) return url;
  const repoPath = parseRepoPath(url);
  if (!repoPath) return url;
  return protocol === 'https'
    ? `https://github.com/${repoPath}.git`
    : `git@github.com:${repoPath}.git`;
}

/**
 * Extracts owner from a GitHub URL
 *
 * @param url - GitHub repository URL (SSH or HTTPS)
 * @returns Owner/organization name (e.g., "facebook" from "github.com/facebook/react")
 *
 * @example
 * parseOwner("git@github.com:facebook/react.git") // "facebook"
 * parseOwner("https://github.com/vercel/next.js.git") // "vercel"
 */
export function parseOwner(url: string): string {
  const match = url.match(/github\.com[:/](.+?)\/.+/);
  return match?.[1] || '';
}

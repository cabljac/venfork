export const DEFAULT_REPO_NAME = 'my-mirror';

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
 * @returns Owner and repository path (e.g., "facebook/react")
 *
 * @example
 * parseRepoPath("git@github.com:facebook/react.git") // "facebook/react"
 * parseRepoPath("https://github.com/vercel/next.js.git") // "vercel/next.js"
 */
export function parseRepoPath(url: string): string {
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match?.[1] || '';
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

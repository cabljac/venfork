import { $ } from 'execa';
import { assertNoMirrorReference } from './deny-list.js';

/**
 * Creates a PR on upstream via gh and returns its URL. Scans the title and
 * body against `denyList` before gh runs. Reports the duplicate-PR case
 * ("already exists") as `alreadyExists` so the caller can recover.
 */
export async function createUpstreamPr(args: {
  upstreamRepoPath: string;
  /** Owner where the head branch lives. Same as upstream owner in no-public mode. */
  headOwner: string;
  /** True when head and base live in the same repo (no-public mode): gh wants a bare branch name, not `owner:branch`. */
  sameRepoHead: boolean;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  denyList: readonly string[];
  cwd: string;
}): Promise<{ url: string; alreadyExists: boolean }> {
  assertNoMirrorReference(args.title, 'the upstream PR title', args.denyList);
  assertNoMirrorReference(args.body, 'the upstream PR body', args.denyList);
  const head = args.sameRepoHead
    ? args.branch
    : `${args.headOwner}:${args.branch}`;
  const result = await $({
    cwd: args.cwd,
    reject: false,
    input: args.body,
  })`gh pr create --repo ${args.upstreamRepoPath} --base ${args.base} --head ${head} --title ${args.title} --body-file - ${args.draft ? '--draft' : []}`;

  if (result.exitCode === 0) {
    return { url: result.stdout.trim(), alreadyExists: false };
  }
  // gh prints something like "a pull request for branch X into branch Y already exists: https://..."
  const combined = `${result.stdout}\n${result.stderr}`;
  const existing = combined.match(/https?:\/\/\S*\/pull\/\d+/);
  if (existing && /already exists/i.test(combined)) {
    return { url: existing[0], alreadyExists: true };
  }
  throw new Error(
    `Failed to create upstream PR via gh: ${combined.trim() || `exit ${result.exitCode}`}`
  );
}

/**
 * Replaces the body of an existing upstream PR. Scans the body against
 * `denyList` before gh runs. Returns gh's exit code and stderr and does not
 * throw when gh fails.
 */
export async function editUpstreamPrBody(args: {
  prUrl: string;
  body: string;
  denyList: readonly string[];
  cwd: string;
}): Promise<{ exitCode: number | undefined; stderr: string }> {
  assertNoMirrorReference(args.body, 'the upstream PR body', args.denyList);
  const result = await $({
    cwd: args.cwd,
    reject: false,
    input: args.body,
  })`gh pr edit ${args.prUrl} --body-file -`;
  return { exitCode: result.exitCode, stderr: result.stderr };
}

async function ghIssueCreate(args: {
  repoPath: string;
  title: string;
  body: string;
  cwd: string;
}): Promise<{ url: string; number: number }> {
  const result = await $({
    cwd: args.cwd,
    reject: false,
    input: args.body,
  })`gh issue create --repo ${args.repoPath} --title ${args.title} --body-file -`;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create issue on ${args.repoPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  const url = result.stdout.trim().split(/\s+/).pop() ?? '';
  const numberMatch = url.match(/\/issues\/(\d+)/);
  if (!numberMatch) {
    throw new Error(`gh issue create returned an unexpected output: ${url}`);
  }
  return { url, number: Number(numberMatch[1]) };
}

/**
 * Creates an issue on upstream and returns its URL and number. Scans the
 * title and body against `denyList` before gh runs.
 */
export async function createUpstreamIssue(args: {
  repoPath: string;
  title: string;
  body: string;
  denyList: readonly string[];
  cwd: string;
}): Promise<{ url: string; number: number }> {
  assertNoMirrorReference(
    args.title,
    'the upstream issue title',
    args.denyList
  );
  assertNoMirrorReference(args.body, 'the upstream issue body', args.denyList);
  return ghIssueCreate(args);
}

/**
 * Creates an issue on the private mirror and returns its URL and number.
 * No scan: the text stays inside the mirror.
 */
export async function createMirrorIssue(args: {
  repoPath: string;
  title: string;
  body: string;
  cwd: string;
}): Promise<{ url: string; number: number }> {
  return ghIssueCreate(args);
}

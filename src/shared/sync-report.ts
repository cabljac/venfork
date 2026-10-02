import * as p from '@clack/prompts';
import { $ } from 'execa';
import { parseRepoPath } from '../utils.js';

/** Label on the mirror issue that tracks a blocked scheduled sync. */
export const SYNC_BLOCKED_LABEL = 'venfork-sync-blocked';

/** URL of the current GitHub Actions run, or null outside Actions. */
export function currentRunUrl(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

async function mirrorRepoPath(cwd: string): Promise<string | null> {
  const result = await $({ cwd, reject: false })`git remote get-url origin`;
  if (result.exitCode !== 0) return null;
  return parseRepoPath(result.stdout.trim()) || null;
}

async function gh(
  cwd: string,
  args: string[],
  input?: string
): Promise<string> {
  const result = await $({
    cwd,
    reject: false,
    ...(input === undefined ? {} : { input }),
  })`gh ${args}`;
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout.trim();
}

async function findOpenIssue(
  cwd: string,
  repo: string
): Promise<number | null> {
  const out = await gh(cwd, [
    'issue',
    'list',
    '--repo',
    repo,
    '--label',
    SYNC_BLOCKED_LABEL,
    '--state',
    'open',
    '--json',
    'number',
    '--limit',
    '1',
  ]);
  const issues = JSON.parse(out || '[]') as Array<{ number: number }>;
  return issues[0]?.number ?? null;
}

/** Issue body for a sync blocked by divergent commits. */
export function syncBlockedBody(
  defaultBranch: string,
  report: string,
  runUrl: string | null
): string {
  return [
    `Scheduled \`venfork sync\` cannot update \`origin/${defaultBranch}\`: it carries commits that upstream does not have. Sync stops instead of discarding them.`,
    '',
    `Last blocked run: ${runUrl ?? 'a local run'}`,
    '',
    '```text',
    report,
    '```',
    '',
    `This issue closes automatically after the next successful sync.`,
  ].join('\n');
}

/**
 * Opens (or refreshes the body of) the mirror issue labelled
 * `venfork-sync-blocked`. Failures are logged, never thrown, so the sync
 * error stays the reported outcome.
 */
export async function reportSyncBlocked(args: {
  cwd: string;
  defaultBranch: string;
  report: string;
}): Promise<void> {
  const { cwd, defaultBranch, report } = args;
  try {
    const repo = await mirrorRepoPath(cwd);
    if (!repo) {
      p.log.warn('Cannot report the blocked sync: origin is not on GitHub.');
      return;
    }
    const body = syncBlockedBody(defaultBranch, report, currentRunUrl());
    await gh(cwd, [
      'label',
      'create',
      SYNC_BLOCKED_LABEL,
      '--repo',
      repo,
      '--color',
      'B60205',
      '--description',
      'Scheduled venfork sync is blocked',
      '--force',
    ]);
    const existing = await findOpenIssue(cwd, repo);
    if (existing === null) {
      const url = await gh(
        cwd,
        [
          'issue',
          'create',
          '--repo',
          repo,
          '--title',
          `Scheduled sync blocked: divergent commits on origin/${defaultBranch}`,
          '--label',
          SYNC_BLOCKED_LABEL,
          '--body-file',
          '-',
        ],
        body
      );
      p.log.info(`Opened ${url}`);
    } else {
      await gh(
        cwd,
        ['issue', 'edit', String(existing), '--repo', repo, '--body-file', '-'],
        body
      );
      p.log.info(`Updated issue #${existing}`);
    }
  } catch (err) {
    p.log.warn(
      `Could not report the blocked sync: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Comments on and closes the open `venfork-sync-blocked` issue, if any,
 * after a successful sync. Failures are logged, never thrown.
 */
export async function resolveSyncBlocked(args: { cwd: string }): Promise<void> {
  const { cwd } = args;
  try {
    const repo = await mirrorRepoPath(cwd);
    if (!repo) return;
    const existing = await findOpenIssue(cwd, repo);
    if (existing === null) return;
    await gh(cwd, [
      'issue',
      'close',
      String(existing),
      '--repo',
      repo,
      '--comment',
      `Resolved by ${currentRunUrl() ?? 'a local run'}.`,
    ]);
    p.log.info(`Closed issue #${existing}`);
  } catch (err) {
    p.log.warn(
      `Could not close the sync-blocked issue: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

import * as p from '@clack/prompts';
import { $ } from 'execa';
import type { SyncDivergenceError } from '../errors.js';
import { parseRepoPath } from '../utils.js';
import { formatDivergenceReport } from './divergence.js';
import { netExec, netFailureReason } from './net.js';

/** Label on the mirror issue that tracks a blocked scheduled sync. */
export const SYNC_BLOCKED_LABEL = 'venfork-sync-blocked';

const MAX_REPORTED_FILES = 100;
const MAX_BODY_CHARS = 60_000;

/** URL of the current GitHub Actions run, or null outside Actions. */
export function currentRunUrl(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

async function gh(
  cwd: string,
  args: string[],
  input?: string
): Promise<string> {
  const result = await netExec(cwd, { bufferOutput: true, input })`gh ${args}`;
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${netFailureReason(result)}`
    );
  }
  return (result.stdout ?? '').trim();
}

/**
 * The mirror repo to file the issue on: `GITHUB_REPOSITORY` inside Actions,
 * otherwise origin's GitHub repo, but only when gh confirms it is private.
 * Returns null (after a warning) when no safe target exists, so mirror
 * details never land on a public repository.
 */
export async function resolveReportRepo(cwd: string): Promise<string | null> {
  const fromActions = process.env.GITHUB_REPOSITORY?.trim();
  if (fromActions) return fromActions;

  const origin = await $({ cwd, reject: false })`git remote get-url origin`;
  const repo = origin.exitCode === 0 ? parseRepoPath(origin.stdout.trim()) : '';
  if (!repo) {
    p.log.warn(
      'Not reporting the sync result: origin is not a GitHub repository.'
    );
    return null;
  }
  let isPrivate = '';
  try {
    isPrivate = await gh(cwd, [
      'repo',
      'view',
      repo,
      '--json',
      'isPrivate',
      '-q',
      '.isPrivate',
    ]);
  } catch (err) {
    p.log.warn(
      `Not reporting the sync result: cannot confirm ${repo} is private (${err instanceof Error ? err.message : String(err)}).`
    );
    return null;
  }
  if (isPrivate !== 'true') {
    p.log.warn(
      `Not reporting the sync result: ${repo} is not a private repository.`
    );
    return null;
  }
  return repo;
}

async function listOpenIssues(cwd: string, repo: string): Promise<number[]> {
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
    '100',
  ]);
  return (JSON.parse(out || '[]') as Array<{ number: number }>).map(
    (issue) => issue.number
  );
}

async function ensureLabel(cwd: string, repo: string): Promise<void> {
  const out = await gh(cwd, [
    'label',
    'list',
    '--repo',
    repo,
    '--search',
    SYNC_BLOCKED_LABEL,
    '--json',
    'name',
  ]);
  const names = (JSON.parse(out || '[]') as Array<{ name: string }>).map(
    (label) => label.name
  );
  if (names.includes(SYNC_BLOCKED_LABEL)) return;
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
  ]);
}

function divergedRefs(error: SyncDivergenceError): string {
  const refs: string[] = [];
  if (error.origin.count > 0) refs.push(`origin/${error.defaultBranch}`);
  if (error.publicFork.count > 0) refs.push(`public/${error.defaultBranch}`);
  return refs.join(' and ');
}

/** Issue title for a sync blocked by divergent commits. */
export function syncBlockedTitle(error: SyncDivergenceError): string {
  return `Scheduled sync blocked: divergent commits on ${divergedRefs(error)}`;
}

/** Issue body for a sync blocked by divergent commits, capped in size. */
export function syncBlockedBody(
  error: SyncDivergenceError,
  runUrl: string | null
): string {
  const refs = divergedRefs(error);
  const head = [
    `Scheduled \`venfork sync\` cannot update the mirror: ${refs} ${refs.includes(' and ') ? 'carry' : 'carries'} commits that upstream does not have. Sync stops instead of discarding them.`,
    '',
    `Last blocked run: ${runUrl ?? 'a local run'}`,
    '',
    '```text',
  ].join('\n');
  const tail = [
    '```',
    '',
    'This issue closes automatically after the next successful sync.',
  ].join('\n');
  let report = formatDivergenceReport(error, { maxFiles: MAX_REPORTED_FILES });
  const budget = MAX_BODY_CHARS - head.length - tail.length - 40;
  if (report.length > budget) {
    report = `${report.slice(0, budget)}\n...(truncated)`;
  }
  return `${head}\n${report}\n${tail}`;
}

/**
 * Opens (or refreshes the title and body of) the mirror issue labelled
 * `venfork-sync-blocked`. Failures are logged, never thrown, so the sync
 * error stays the reported outcome.
 */
export async function reportSyncBlocked(args: {
  cwd: string;
  error: SyncDivergenceError;
}): Promise<void> {
  const { cwd, error } = args;
  try {
    const repo = await resolveReportRepo(cwd);
    if (!repo) return;
    const title = syncBlockedTitle(error);
    const body = syncBlockedBody(error, currentRunUrl());
    await ensureLabel(cwd, repo);
    const [existing] = await listOpenIssues(cwd, repo);
    if (existing === undefined) {
      const url = await gh(
        cwd,
        [
          'issue',
          'create',
          '--repo',
          repo,
          '--title',
          title,
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
        [
          'issue',
          'edit',
          String(existing),
          '--repo',
          repo,
          '--title',
          title,
          '--body-file',
          '-',
        ],
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
 * Comments on and closes every open `venfork-sync-blocked` issue after a
 * successful sync. Failures are logged, never thrown.
 */
export async function resolveSyncBlocked(args: { cwd: string }): Promise<void> {
  const { cwd } = args;
  try {
    const repo = await resolveReportRepo(cwd);
    if (!repo) return;
    for (const number of await listOpenIssues(cwd, repo)) {
      await gh(cwd, [
        'issue',
        'close',
        String(number),
        '--repo',
        repo,
        '--comment',
        `Resolved by ${currentRunUrl() ?? 'a local run'}.`,
      ]);
      p.log.info(`Closed issue #${number}`);
    }
  } catch (err) {
    p.log.warn(
      `Could not close the sync-blocked issue: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

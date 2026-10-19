import { $ } from 'execa';
import { updateVenforkConfig } from '../config.js';
import {
  CommandExitError,
  GitHubError,
  PreconditionError,
  RemoteNotFoundError,
  UsageError,
} from '../errors.js';
import { parseGitHubRef } from '../shared/args.js';
import {
  assertNoMirrorReference,
  mirrorDenyList,
} from '../shared/deny-list.js';
import {
  assertCanConfirm,
  isCancel,
  type PromptContext,
  promptConfirm,
} from '../shared/prompt.js';
import {
  translateInternalBody,
  translateInternalTitle,
} from '../shared/redaction.js';
import { findMirrorRepoPath } from '../shared/repo.js';
import * as p from '../shared/ui.js';
import {
  createMirrorIssue,
  createUpstreamIssue,
} from '../shared/upstream-publish.js';
import { parseRepoPath } from '../utils.js';

/** Starts the missing-input error of the open-issue confirm. */
const NOT_OPENED = 'Not opened.';

/** One comment on a GitHub issue as returned by `gh issue view --json comments`. */
export interface IssueComment {
  author?: { login: string };
  /** Optional: gh may omit a body for reaction-only or deleted comments. */
  body?: string;
  /** ISO timestamp from gh. */
  createdAt?: string;
}

interface IssueMeta {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  author?: { login: string };
  comments?: IssueComment[];
}

async function readIssue(
  repoPath: string,
  number: number,
  cwd: string
): Promise<IssueMeta> {
  const result = await $({
    cwd,
    reject: false,
  })`gh issue view ${number} --repo ${repoPath} --json number,url,title,body,state,author,comments`;
  if (result.exitCode !== 0) {
    throw new GitHubError(
      `Failed to read issue #${number} from ${repoPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return JSON.parse(result.stdout) as IssueMeta;
}

/**
 * Renders upstream issue comments into a Markdown section for the mirror copy
 * created by `venfork pull issue`. Returns an empty string when there are no
 * comments so the body stays clean.
 *
 * @internal Exported for unit testing.
 */
export function renderPulledComments(
  comments: IssueComment[] | undefined
): string {
  if (!comments || comments.length === 0) return '';
  const blocks = comments.map((c) => {
    const who = c.author?.login ? `@${c.author.login}` : '(unknown)';
    const when = c.createdAt ? ` — ${c.createdAt}` : '';
    return `**${who}**${when}:\n\n${c.body?.trim() || '(empty)'}`;
  });
  const label = comments.length === 1 ? 'comment' : 'comments';
  return `\n\n---\n\n### Upstream ${label} (${comments.length})\n\n${blocks.join('\n\n---\n\n')}`;
}

/** Resolve a number or same-repo URL to a positive number; throws on anything else. */
export function resolveIssueArg(
  target: string,
  expectedRepoPath: string
): { number: number } {
  const { number, repoPath } = parseGitHubRef(target, 'issues');
  if (
    repoPath !== undefined &&
    repoPath.toLowerCase() !== expectedRepoPath.toLowerCase()
  ) {
    throw new PreconditionError(
      `Refused to use issue URL ${target}: it points to ${repoPath}, but the expected repo is ${expectedRepoPath}. If this is intentional, pass the issue number directly.`
    );
  }
  return { number };
}

/**
 * `--json` result of `venfork stage issue` and `venfork pull issue`: the
 * issue venfork opened, and the issue it was made from.
 */
export interface IssueResult {
  number: number;
  url: string;
  source: { number: number; url: string };
}

function issueUsage(action: 'stage' | 'pull' | undefined): string {
  if (action === 'stage') return 'stage issue';
  if (action === 'pull') return 'pull issue';
  return '<stage|pull> issue';
}

/**
 * Issue command: stage an internal issue to upstream, or pull an upstream
 * issue into the mirror for internal triage. Body translation uses the same
 * `<!-- venfork:internal -->...<!-- /venfork:internal -->` markers as
 * `stage <branch>`. No comment sync: the linkage is one-shot.
 * @returns The opened issue, for `--json`.
 */
export async function issueCommand(
  action: 'stage' | 'pull' | undefined,
  target: string | undefined,
  options: { title?: string; prompt?: PromptContext } = {}
): Promise<IssueResult> {
  if (!action || !target) {
    throw new UsageError(
      `Missing issue number or URL. Usage: venfork ${issueUsage(action)} <number-or-url> [--title <text>]`
    );
  }

  if (action !== 'stage' && action !== 'pull') {
    throw new UsageError(
      `Unknown action '${action}'. Expected one of: stage, pull.`
    );
  }

  p.intro('🐛 Venfork Issue');

  const s = p.spinner();
  const repoDir = process.cwd();
  try {
    s.start('Resolving remotes');
    const upstreamUrlResult = await $({
      cwd: repoDir,
      reject: false,
    })`git remote get-url upstream`;
    if (upstreamUrlResult.exitCode !== 0) {
      throw new RemoteNotFoundError('upstream');
    }
    const upstreamRepoPath = parseRepoPath(upstreamUrlResult.stdout.trim());
    if (!upstreamRepoPath) {
      throw new PreconditionError(
        `Could not parse upstream remote URL: ${upstreamUrlResult.stdout.trim()}`
      );
    }
    const mirrorRepoPath = await findMirrorRepoPath(repoDir);
    if (!mirrorRepoPath) {
      throw new RemoteNotFoundError('origin');
    }
    s.stop(`Mirror: ${mirrorRepoPath} | Upstream: ${upstreamRepoPath}`);

    if (action === 'stage') {
      const { number: internalNumber } = resolveIssueArg(
        target,
        mirrorRepoPath
      );
      const question = `Open the issue on ${upstreamRepoPath}?`;
      assertCanConfirm(question, options.prompt, NOT_OPENED);

      s.start(`Reading internal issue #${internalNumber}`);
      const internal = await readIssue(mirrorRepoPath, internalNumber, repoDir);
      s.stop(`Read: ${internal.title}`);

      const translatedBody = translateInternalBody(internal.body);
      const upstreamTitle = translateInternalTitle(
        options.title ?? internal.title
      );
      const denyList = await mirrorDenyList(repoDir);
      assertNoMirrorReference(
        upstreamTitle,
        'the upstream issue title',
        denyList
      );
      assertNoMirrorReference(
        translatedBody,
        'the upstream issue body',
        denyList
      );

      p.note(
        [
          `Internal: #${internal.number} ${internal.title} (${internal.state})`,
          `Upstream target: ${upstreamRepoPath}`,
          '',
          `Title: ${upstreamTitle}`,
        ].join('\n'),
        'Issue Stage'
      );
      p.note(translatedBody || '(empty)', 'Upstream issue body preview');

      const ok = await promptConfirm(
        {
          message: question,
          initialValue: false,
          stopped: NOT_OPENED,
        },
        options.prompt
      );
      if (isCancel(ok) || !ok) {
        p.outro('Stage cancelled');
        throw new CommandExitError(isCancel(ok) ? 130 : 0);
      }

      s.start('Opening upstream issue');
      const created = await createUpstreamIssue({
        repoPath: upstreamRepoPath,
        title: upstreamTitle,
        body: translatedBody,
        denyList,
        cwd: repoDir,
      });
      s.stop(`Upstream issue created: ${created.url}`);

      try {
        await updateVenforkConfig(repoDir, {
          shippedIssues: {
            [String(internalNumber)]: {
              internalIssueNumber: internalNumber,
              internalIssueUrl: internal.url,
              upstreamIssueNumber: created.number,
              upstreamIssueUrl: created.url,
              shippedAt: new Date().toISOString(),
            },
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(`Could not record shippedIssues entry: ${msg}`);
      }

      p.outro(`✨ Issue staged: ${created.url}`);
      return {
        number: created.number,
        url: created.url,
        source: { number: internal.number, url: internal.url },
      };
    }

    // action === 'pull'
    const { number: upstreamNumber } = resolveIssueArg(
      target,
      upstreamRepoPath
    );
    const question = `Open the issue on ${mirrorRepoPath}?`;
    assertCanConfirm(question, options.prompt, NOT_OPENED);

    s.start(`Reading upstream issue #${upstreamNumber}`);
    const upstream = await readIssue(upstreamRepoPath, upstreamNumber, repoDir);
    const commentCount = upstream.comments?.length ?? 0;
    s.stop(
      `Read: ${upstream.title} (${upstream.state}, ${commentCount} comment${commentCount === 1 ? '' : 's'})`
    );

    const internalTitle =
      options.title ?? `[upstream #${upstream.number}] ${upstream.title}`;
    const internalBody = `${upstream.body || '(no body provided)'}${renderPulledComments(upstream.comments)}\n\n> Pulled from upstream issue: ${upstream.url}\n> Author: ${upstream.author?.login ?? '(unknown)'}\n> State: ${upstream.state}`;

    p.note(
      [
        `Upstream: #${upstream.number} ${upstream.title} (${upstream.state})`,
        `Mirror target: ${mirrorRepoPath}`,
        '',
        `Title: ${internalTitle}`,
      ].join('\n'),
      'Issue Pull'
    );
    p.note(internalBody, 'Internal issue body preview');

    const ok = await promptConfirm(
      {
        message: question,
        initialValue: false,
        stopped: NOT_OPENED,
      },
      options.prompt
    );
    if (isCancel(ok) || !ok) {
      p.outro('Pull cancelled');
      throw new CommandExitError(isCancel(ok) ? 130 : 0);
    }

    s.start('Opening internal issue');
    const created = await createMirrorIssue({
      repoPath: mirrorRepoPath,
      title: internalTitle,
      body: internalBody,
      cwd: repoDir,
    });
    s.stop(`Internal issue created: ${created.url}`);

    try {
      await updateVenforkConfig(repoDir, {
        pulledIssues: {
          [String(created.number)]: {
            upstreamIssueNumber: upstreamNumber,
            upstreamIssueUrl: upstream.url,
            internalIssueNumber: created.number,
            internalIssueUrl: created.url,
            pulledAt: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.warn(`Could not record pulledIssues entry: ${msg}`);
    }

    p.outro(`✨ Issue pulled: ${created.url}`);
    return {
      number: created.number,
      url: created.url,
      source: { number: upstream.number, url: upstream.url },
    };
  } catch (error) {
    throw p.reportFailure(error, s);
  }
}

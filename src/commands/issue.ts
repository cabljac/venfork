import * as p from '@clack/prompts';
import { $ } from 'execa';
import { updateVenforkConfig } from '../config.js';
import { RemoteNotFoundError } from '../errors.js';
import { confirmOrAutoYes } from '../shared/confirm.js';
import {
  translateInternalBody,
  translateInternalTitle,
} from '../shared/redaction.js';
import { findMirrorRepoPath } from '../shared/repo.js';
import { parseRepoPath } from '../utils.js';

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
    throw new Error(
      `Failed to read issue #${number} from ${repoPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return JSON.parse(result.stdout) as IssueMeta;
}

/**
 * Renders upstream issue comments into a Markdown section for the mirror copy
 * created by `venfork issue pull`. Returns an empty string when there are no
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

async function createIssue(args: {
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

function resolveIssueArg(
  target: string,
  expectedRepoPath: string
): { number: number } {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) {
    return { number: Number(trimmed) };
  }
  const match = trimmed.match(
    /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/issues\/(\d+)/
  );
  if (!match) {
    throw new Error(
      `Could not parse issue reference: ${target}. Expected an integer or a github.com/<owner>/<repo>/issues/<n> URL.`
    );
  }
  const [, sourceRepoPath, num] = match;
  if (sourceRepoPath !== expectedRepoPath) {
    throw new Error(
      `Refused to use issue URL ${target}: it points to ${sourceRepoPath}, but the expected repo is ${expectedRepoPath}. If this is intentional, pass the issue number directly.`
    );
  }
  return { number: Number(num) };
}

/**
 * Issue command: stage an internal issue to upstream, or pull an upstream
 * issue into the mirror for internal triage. Body translation uses the same
 * `<!-- venfork:internal -->...<!-- /venfork:internal -->` markers as
 * `stage --pr`. No comment sync — the linkage is one-shot.
 */
export async function issueCommand(
  action: 'stage' | 'pull' | undefined,
  target: string | undefined,
  options: { title?: string } = {}
): Promise<void> {
  p.intro('🐛 Venfork Issue');

  if (!action || !target) {
    p.log.error(
      'Usage: venfork issue <stage|pull> <number-or-url> [--title <text>]'
    );
    p.outro('');
    process.exit(1);
  }

  if (action !== 'stage' && action !== 'pull') {
    p.log.error(
      `Unknown action '${action}'. Usage: venfork issue <stage|pull> <number-or-url> [--title <text>]`
    );
    p.outro('');
    process.exit(1);
  }

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
      throw new Error(
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

      s.start(`Reading internal issue #${internalNumber}`);
      const internal = await readIssue(mirrorRepoPath, internalNumber, repoDir);
      s.stop(`Read: ${internal.title}`);

      const translatedBody = translateInternalBody(internal.body);
      const upstreamTitle = translateInternalTitle(
        options.title ?? internal.title
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

      const ok = await confirmOrAutoYes({
        message: `Open the issue on ${upstreamRepoPath}?`,
        initialValue: false,
        allowNonInteractive: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.outro('Stage cancelled');
        process.exit(0);
      }

      s.start('Opening upstream issue');
      const created = await createIssue({
        repoPath: upstreamRepoPath,
        title: upstreamTitle,
        body: translatedBody,
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
      return;
    }

    // action === 'pull'
    const { number: upstreamNumber } = resolveIssueArg(
      target,
      upstreamRepoPath
    );

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

    const ok = await confirmOrAutoYes({
      message: `Open the issue on ${mirrorRepoPath}?`,
      initialValue: false,
      allowNonInteractive: true,
    });
    if (p.isCancel(ok) || !ok) {
      p.outro('Pull cancelled');
      process.exit(0);
    }

    s.start('Opening internal issue');
    const created = await createIssue({
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
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Issue command failed');
    process.exit(1);
  }
}

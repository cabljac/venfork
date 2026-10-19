import { $ } from 'execa';
import { updateVenforkConfig } from '../config.js';
import {
  GitError,
  GitHubError,
  PreconditionError,
  RemoteNotFoundError,
  UsageError,
} from '../errors.js';
import { PULL_PR_USAGE } from '../pull-args.js';
import { parseGitHubRef } from '../shared/args.js';
import { netExec, netFailureReason } from '../shared/net.js';
import * as p from '../shared/ui.js';
import { parseRepoPath, shellQuote } from '../utils.js';

export interface PullRequestOptions {
  /** Local + mirror branch name to write the PR's commits to. */
  branchName?: string;
  /** When false, only fetch locally; do not push to the mirror. */
  push?: boolean;
}

/** `--json` result of `venfork pull pr`. */
export interface PullPrResult {
  /** The local branch holding the PR head. */
  branch: string;
  head: string;
  prNumber: number;
  prUrl: string;
  /** False with `--no-push` or when the push to origin failed. */
  pushed: boolean;
}

/**
 * Resolves a `<pr>` argument (bare number or PR URL) to a numeric PR id.
 * A URL must point at `upstreamRepoPath`.
 */
export function resolvePullRequestArg(
  pr: string,
  upstreamRepoPath: string
): { number: number; sourceRepoPath?: string } {
  const { number, repoPath } = parseGitHubRef(pr, 'pull');
  if (repoPath === undefined) return { number };
  if (repoPath.toLowerCase() !== upstreamRepoPath.toLowerCase()) {
    throw new PreconditionError(
      `Refused to use PR URL ${pr}: it points to ${repoPath}, but the upstream remote is ${upstreamRepoPath}. If this is intentional, pass the PR number directly (\`venfork pull pr ${number}\`).`
    );
  }
  return { number, sourceRepoPath: repoPath };
}

interface UpstreamPrMeta {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  author?: { login: string };
  headRepositoryOwner?: { login: string };
}

async function fetchUpstreamPrMeta(
  upstreamRepoPath: string,
  prNumber: number,
  cwd: string
): Promise<UpstreamPrMeta> {
  const fields =
    'number,title,body,url,state,baseRefName,headRefName,author,headRepositoryOwner';
  const result = await $({
    cwd,
    reject: false,
  })`gh pr view ${prNumber} --repo ${upstreamRepoPath} --json ${fields}`;
  if (result.exitCode !== 0) {
    throw new GitHubError(
      `Failed to read upstream PR #${prNumber} from ${upstreamRepoPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return JSON.parse(result.stdout) as UpstreamPrMeta;
}

/**
 * Pull-request command: bring an upstream PR's commits into the private mirror
 * for internal review. Fetches `pull/<n>/head` from the upstream remote onto a
 * local branch (default `upstream-pr/<n>`), pushes to origin so the team can
 * see it, and records a `pulledPrs` entry so `venfork sync <branch>` can
 * later refresh it.
 * @returns The pulled branch, for `--json`.
 */
export async function pullRequestCommand(
  pr: string | undefined,
  options: PullRequestOptions = {}
): Promise<PullPrResult> {
  if (!pr) {
    throw new UsageError(`Missing PR number or URL. Usage: ${PULL_PR_USAGE}`);
  }

  p.intro('🔀 Venfork Pull Request');

  const s = p.spinner();
  const repoDir = process.cwd();

  try {
    s.start('Resolving upstream remote');
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
    s.stop(`Upstream: ${upstreamRepoPath}`);

    const { number: prNumber } = resolvePullRequestArg(pr, upstreamRepoPath);
    const localBranch = options.branchName ?? `upstream-pr/${prNumber}`;
    const push = options.push !== false;

    s.start(`Reading upstream PR #${prNumber} metadata`);
    const meta = await fetchUpstreamPrMeta(upstreamRepoPath, prNumber, repoDir);
    s.stop(`Read PR: ${meta.title} (${meta.state})`);

    // Refuse to clobber an existing local branch unless the user opts in via
    // a custom --branch-name. This prevents stomping on a previous review.
    const existing = await $({
      cwd: repoDir,
      reject: false,
    })`git rev-parse --verify ${localBranch}`;
    if (existing.exitCode === 0 && !options.branchName) {
      throw new PreconditionError(
        `Local branch '${localBranch}' already exists. Pass --branch-name <override> to use a different name, or delete the existing branch first.`
      );
    }

    s.start(`Fetching pull/${prNumber}/head from upstream`);
    const fetchRefspec = `pull/${prNumber}/head:${localBranch}`;
    const fetchResult = await netExec(repoDir, {
      bufferOutput: true,
    })`git fetch upstream ${fetchRefspec}`;
    if (fetchResult.exitCode !== 0) {
      throw new GitError(
        `git fetch upstream ${fetchRefspec} failed. This can happen if the PR's source branch was deleted, or if the local branch already exists at a different commit (try deleting or renaming it first). Stderr:\n${netFailureReason(fetchResult)}`,
        'git fetch upstream'
      );
    }
    const headSha = (
      await $({ cwd: repoDir })`git rev-parse ${localBranch}`
    ).stdout.trim();
    s.stop(`Fetched ${headSha.slice(0, 9)} → ${localBranch}`);

    let pushedToMirror = false;
    const result = (): PullPrResult => ({
      branch: localBranch,
      head: headSha,
      prNumber,
      prUrl: meta.url,
      pushed: pushedToMirror,
    });
    if (push) {
      s.start(`Pushing ${localBranch} to origin`);
      const pushResult = await netExec(repoDir, {
        bufferOutput: true,
      })`git push origin ${localBranch} --no-follow-tags`;
      if (pushResult.exitCode !== 0) {
        s.clear();
        p.log.error(
          `Could not push ${localBranch} to origin; the branch is local only. Fix the push, then run \`venfork pull pr ${prNumber} --branch-name ${shellQuote(localBranch)}\` again. Reason: ${netFailureReason(pushResult)}`
        );
      } else {
        s.stop(`Pushed ${localBranch} to origin`);
        pushedToMirror = true;
      }
    }

    if (!pushedToMirror) {
      // Two paths reach here:
      // 1. Push failed: reported above, branch is local-only.
      // 2. --no-push: user asked us not to push; treat the branch as
      //    local-only too. In both cases the mirror does not have the
      //    branch, so we skip the pulledPrs record. Otherwise a later
      //    `venfork sync <branch>` would push the branch to the mirror —
      //    surprising for --no-push users (who explicitly opted out of
      //    mirror state) and misleading for the failure case (the mirror
      //    is out of sync with what we recorded).
      const reason = push
        ? 'mirror push failed'
        : '--no-push set, branch is local-only';
      p.outro(
        push
          ? 'Pull incomplete: the branch is local only.'
          : `✨ Pull request fetched locally (${reason})`
      );
      return result();
    }

    try {
      await updateVenforkConfig(repoDir, {
        pulledPrs: {
          [localBranch]: {
            upstreamPrNumber: prNumber,
            upstreamPrUrl: meta.url,
            head: headSha,
            lastSyncedAt: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.warn(
        `Could not record pulledPrs entry: ${msg}. \`venfork sync ${localBranch}\` will fall back to convention-based resolution.`
      );
    }

    const bodyPreview =
      meta.body.length > 600
        ? `${meta.body.slice(0, 600)}\n…(truncated)`
        : meta.body || '(empty)';
    const headRepo = meta.headRepositoryOwner?.login
      ? `${meta.headRepositoryOwner.login}:${meta.headRefName}`
      : meta.headRefName;
    p.note(
      [
        `Title:  ${meta.title}`,
        `Author: ${meta.author?.login ?? '(unknown)'}`,
        `State:  ${meta.state}`,
        `Base:   ${meta.baseRefName}`,
        `Head:   ${headRepo}`,
        `URL:    ${meta.url}`,
        '',
        bodyPreview,
      ].join('\n'),
      `Upstream PR #${prNumber}`
    );

    p.note(
      [
        `git checkout ${localBranch}`,
        `# review locally; open an internal PR on the mirror if you want team review`,
        `# refresh later with: venfork sync ${localBranch}`,
      ].join('\n'),
      'Next Steps'
    );

    p.outro('✨ Pull request imported!');
    return result();
  } catch (error) {
    throw p.reportFailure(error, s);
  }
}

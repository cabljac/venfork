import { $ } from 'execa';
import {
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfig,
} from '../config.js';
import {
  GitError,
  GitHubError,
  PreconditionError,
  RemoteNotFoundError,
  UsageError,
} from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { PULL_PR_USAGE } from '../pull-args.js';
import { parseGitHubRef } from '../shared/args.js';
import { pushBranchWithLease, resolveCommit } from '../shared/mirror-commit.js';
import { netExec, netFailureReason } from '../shared/net.js';
import * as p from '../shared/ui.js';
import { parseRepoPath, shellQuote } from '../utils.js';

const CONFIG_BRANCH = 'venfork-config';

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
  /**
   * True when this PR's copy already existed (locally, on origin or in
   * `pulledPrs`), even when its head did not move.
   */
  refreshed: boolean;
}

/**
 * True when the local `branch` is venfork's copy of upstream PR `prNumber`:
 * recorded in `pulledPrs`, or, with no record, named `upstream-pr/<n>`.
 */
function isPulledCopy(
  branch: string,
  prNumber: number,
  config: VenforkConfig | null
): boolean {
  const recorded = config?.pulledPrs?.[branch];
  if (recorded) return recorded.upstreamPrNumber === prNumber;
  return branch === `upstream-pr/${prNumber}`;
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

/** Fetches `pull/<n>/head` from upstream without writing a branch; returns its SHA. */
async function fetchPrHead(prNumber: number, cwd: string): Promise<string> {
  const prRef = `pull/${prNumber}/head`;
  const fetched = await netExec(cwd, {
    bufferOutput: true,
  })`git fetch upstream ${prRef}`;
  if (fetched.exitCode !== 0) {
    throw new GitError(
      `git fetch upstream ${prRef} failed. This can happen if the PR's source branch was deleted. Stderr:\n${netFailureReason(fetched)}`,
      'git fetch upstream'
    );
  }
  const head = await resolveCommit('FETCH_HEAD', cwd);
  if (!head) {
    throw new GitError(
      `git fetch upstream ${prRef} wrote no commit`,
      'git fetch upstream'
    );
  }
  return head;
}

/**
 * Fetches `origin/<branch>` fresh and returns its tip, or an empty string
 * when origin has no such branch.
 */
async function fetchOriginBranch(branch: string, cwd: string): Promise<string> {
  const head = `refs/heads/${branch}`;
  const listed = await netExec(cwd, {
    bufferOutput: true,
  })`git ls-remote origin ${head}`;
  if (listed.exitCode !== 0) {
    throw new GitError(
      `git ls-remote origin ${head} failed: ${netFailureReason(listed)}`,
      'git ls-remote origin'
    );
  }
  if (!String(listed.stdout ?? '').trim()) return '';
  const tracking = `refs/remotes/origin/${branch}`;
  const fetched = await netExec(cwd, {
    bufferOutput: true,
  })`git fetch origin ${`+${head}:${tracking}`}`;
  if (fetched.exitCode !== 0) {
    throw new GitError(
      `git fetch origin ${head} failed: ${netFailureReason(fetched)}`,
      'git fetch origin'
    );
  }
  return resolveCommit(tracking, cwd);
}

/** Number of commits reachable from `tip` but from none of `kept`. */
async function countCommitsOutside(
  tip: string,
  kept: string[],
  cwd: string
): Promise<number> {
  const result = await $({ cwd })`git rev-list --count ${tip} --not ${kept}`;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

/**
 * Moves the local `branch` from `from` (empty when it does not exist) to
 * `to`. A branch checked out here moves with `git reset --keep`, so
 * unstaged changes survive or the move is refused; staged changes are
 * refused, since `reset --keep` would reset the index. A branch checked out
 * in another worktree is refused.
 */
async function moveLocalBranch(
  branch: string,
  from: string,
  to: string,
  cwd: string,
  rerun: string
): Promise<void> {
  if (from === to) return;
  const ref = `refs/heads/${branch}`;
  const head = await $({ cwd, reject: false })`git symbolic-ref -q HEAD`;
  if (from && head.stdout.trim() === ref) {
    const staged = await $({
      cwd,
      reject: false,
    })`git diff --cached --quiet`;
    if (staged.exitCode !== 0) {
      throw new PreconditionError(
        `Refused to update ${branch}: it is checked out and has staged changes.`,
        { hint: `Commit or stash them, then re-run \`${rerun}\`.` }
      );
    }
    const reset = await $({
      cwd,
      reject: false,
    })`git reset --quiet --keep ${to}`;
    if (reset.exitCode !== 0) {
      throw new PreconditionError(
        `Refused to update ${branch}: it is checked out and has uncommitted changes the new PR head would overwrite.`,
        { hint: `Commit or stash them, then re-run \`${rerun}\`.` }
      );
    }
    return;
  }
  const worktrees = await $({ cwd })`git worktree list --porcelain`;
  if (worktrees.stdout.split('\n').includes(`branch ${ref}`)) {
    throw new PreconditionError(
      `Refused to update ${branch}: it is checked out in another worktree.`,
      {
        hint: `Switch that worktree to another branch, or run \`${rerun}\` there.`,
      }
    );
  }
  if (from) {
    await $({ cwd })`git update-ref ${ref} ${to} ${from}`;
  } else {
    await $({ cwd })`git branch ${branch} ${to}`;
  }
}

/**
 * Pull-request command: bring an upstream PR's commits into the private mirror
 * for internal review. Fetches `pull/<n>/head` from the upstream remote onto a
 * local branch (default `upstream-pr/<n>`), pushes to origin so the team can
 * see it, and records a `pulledPrs` entry. Re-running it on a branch that
 * already holds the PR refreshes that branch to the PR's current head, and
 * refuses when that would drop commits that are not in the PR.
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

    const config = await readVenforkConfigFromRepo(repoDir);
    const record = config?.pulledPrs?.[localBranch];
    const pulledCopy = isPulledCopy(localBranch, prNumber, config);
    if (options.branchName) {
      const defaultBranch = await getDefaultBranch('upstream', repoDir);
      if (localBranch === defaultBranch || localBranch === CONFIG_BRANCH) {
        throw new PreconditionError(
          `Refused to pull upstream PR #${prNumber} into ${localBranch}: it is the mirror's ${localBranch === CONFIG_BRANCH ? 'config' : 'default'} branch.`,
          {
            hint: `Pass another --branch-name, or omit it to use upstream-pr/${prNumber}.`,
          }
        );
      }
    }
    const localTip = await resolveCommit(`refs/heads/${localBranch}`, repoDir);
    const trackedTip = await resolveCommit(
      `refs/remotes/origin/${localBranch}`,
      repoDir
    );

    s.start(`Fetching pull/${prNumber}/head from upstream`);
    const headSha = await fetchPrHead(prNumber, repoDir);
    const originTip = push ? await fetchOriginBranch(localBranch, repoDir) : '';
    s.stop(`Fetched ${headSha.slice(0, 9)} (PR #${prNumber})`);

    if (!pulledCopy) {
      // A branch that already holds exactly the PR head loses nothing, so a re-run after a failed push works.
      for (const [tip, what] of [
        [localTip, `Local branch '${localBranch}' already exists`],
        [originTip, `Branch '${localBranch}' already exists on origin`],
      ] as const) {
        if (tip && tip !== headSha) {
          throw new PreconditionError(
            `${what} and is not venfork's copy of upstream PR #${prNumber}.`,
            {
              hint: `Pass --branch-name <new-name> to pull the PR beside it, or delete ${localBranch} first.`,
            }
          );
        }
      }
    }

    const recordMatches = record?.upstreamPrNumber === prNumber;
    const refresh =
      pulledCopy && Boolean(localTip || originTip || recordMatches);
    // The recorded head holds the PR commits a rebased PR drops on purpose.
    const baseline =
      record && recordMatches ? await resolveCommit(record.head, repoDir) : '';
    const kept = [headSha, baseline].filter(Boolean);
    const rerun = `venfork pull pr ${prNumber}${options.branchName ? ` --branch-name ${shellQuote(localBranch)}` : ''}`;
    // Local commits that origin had before this fetch are not local-only, even when a teammate's refresh dropped them.
    for (const [tip, where, keptHere] of [
      [localTip, localBranch, [...kept, trackedTip].filter(Boolean)],
      [originTip, `origin/${localBranch}`, kept],
    ] as const) {
      if (!tip) continue;
      const lost = await countCommitsOutside(tip, keptHere, repoDir);
      if (lost > 0) {
        throw new PreconditionError(
          `Refused to update ${localBranch}: ${lost} commit(s) on ${where} are not in upstream PR #${prNumber} and would be lost.`,
          {
            hint: 'Move them to another branch, or pass --branch-name <new-name> to pull the PR beside them.',
            details: { branch: localBranch, ref: where, commits: lost },
          }
        );
      }
    }
    await moveLocalBranch(localBranch, localTip, headSha, repoDir, rerun);

    let pushedToMirror = false;
    const result = (): PullPrResult => ({
      branch: localBranch,
      head: headSha,
      prNumber,
      prUrl: meta.url,
      pushed: pushedToMirror,
      refreshed: refresh,
    });
    if (push) {
      s.start(`Pushing ${localBranch} to origin`);
      const failure = await pushBranchWithLease({
        remote: 'origin',
        branch: localBranch,
        target: headSha,
        expected: originTip,
        cwd: repoDir,
        rerun,
      }).then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      );
      if (failure !== undefined) {
        s.clear();
        p.log.error(
          `Could not push ${localBranch} to origin; the branch is local only. Fix the push, then run \`${rerun}\` again. Reason: ${failure}`
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
      //    re-run of `venfork pull pr <n>` would push the branch to the
      //    mirror, surprising for --no-push users (who explicitly opted out
      //    of mirror state) and misleading for the failure case (the mirror
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
        `Could not record pulledPrs entry: ${msg}. Re-run \`${rerun}\` to record it.`
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
        `# refresh later with: ${rerun}`,
      ].join('\n'),
      'Next Steps'
    );

    p.outro(
      refresh
        ? `✨ ${localBranch} refreshed from upstream PR #${prNumber}`
        : '✨ Pull request imported!'
    );
    return result();
  } catch (error) {
    throw p.reportFailure(error, s);
  }
}

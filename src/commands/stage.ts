import { $ } from 'execa';
import {
  type ApprovalLevel,
  approvalOf,
  assertNoInvalidPreserve,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
} from '../config.js';
import {
  ApprovalError,
  type ApprovalRefusal,
  BranchNotFoundError,
  CommandExitError,
  GitError,
  PreconditionError,
  RemoteNotFoundError,
  UsageError,
  VenforkError,
} from '../errors.js';
import { getDefaultBranch } from '../git.js';
import {
  checkApprovalGate,
  type GateLevel,
  ghLogin,
  recordBypassOnMirrorPr,
} from '../shared/approval.js';
import {
  describeWeakening,
  findWeakening,
  rememberApproval,
  type Weakening,
} from '../shared/approval-guard.js';
import { WORKFLOWS_DIR } from '../shared/constants.js';
import {
  assertNoMirrorReference,
  mirrorDenyList,
} from '../shared/deny-list.js';
import { changedFilesInCommit } from '../shared/divergence.js';
import {
  classifyManagedCommit,
  type ManagedCommitKind,
} from '../shared/managed-commit.js';
import { resolveCommit } from '../shared/mirror-commit.js';
import { netExec, netFailureReason, netFetch } from '../shared/net.js';
import {
  assertCanConfirm,
  canPrompt,
  isCancel,
  type PromptContext,
  promptConfirm,
} from '../shared/prompt.js';
import {
  findInternalPr,
  type InternalPrInfo,
  translateInternalBody,
  translateInternalTitle,
} from '../shared/redaction.js';
import { findMirrorRepoPath } from '../shared/repo.js';
import {
  assertPreserveEntriesAreNotDirectories,
  assertPublishableCommits,
  collectMirrorBlobs,
} from '../shared/stage-gate.js';
import * as p from '../shared/ui.js';
import {
  createUpstreamPr,
  editUpstreamPrBody,
  findOpenUpstreamPr,
} from '../shared/upstream-publish.js';
import { withDetachedWorktree } from '../shared/worktree.js';
import { STAGE_USAGE } from '../stage-args.js';
import { parseRepoPath, shellQuote } from '../utils.js';

const CONFIG_BRANCH = 'venfork-config';

/** Starts the missing-input error of the push confirm. */
const NOT_STAGED = 'Not staged.';

/**
 * Files a merge commit resolves *differently* from both parents.
 *
 * `git diff-tree --cc` omits hunks where the merge result matches either
 * parent verbatim, so an empty list means the merge contains no human-authored
 * conflict resolution we could lose by skipping the merge commit. A non-empty
 * list whose entries are all under `.github/workflows/` is also safe: the
 * public fork has no managed workflow file, so a workflow-file resolution is
 * irrelevant there. Anything else indicates a real "evil merge" whose content
 * would be lost if we dropped the merge during stage.
 */
async function mergeCommitEvilFiles(
  ref: string,
  cwd: string
): Promise<string[]> {
  const result = await $({
    cwd,
    reject: false,
  })`git diff-tree --cc --name-only --no-commit-id ${ref}`;
  if (result.exitCode !== 0) {
    const gitError =
      result.stderr.trim() || result.stdout.trim() || 'git diff-tree failed';
    throw new GitError(
      `Failed to inspect merge commit ${ref}: ${gitError}`,
      'git show'
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function assertNoEvilMerges(
  ref: string,
  branch: string,
  base: string,
  defaultBranch: string,
  cwd: string
): Promise<void> {
  const mergeListResult = await $({
    cwd,
  })`git rev-list --merges ${`${base}..${ref}`}`;
  const mergeCommits = mergeListResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const mergeRef of mergeCommits) {
    const evilFiles = await mergeCommitEvilFiles(mergeRef, cwd);
    const hasNonWorkflowEvil = evilFiles.some(
      (filePath) => !filePath.startsWith(`${WORKFLOWS_DIR}/`)
    );
    if (hasNonWorkflowEvil) {
      const shortRef = mergeRef.slice(0, 9);
      throw new PreconditionError(
        `Failed to stage '${branch}': merge commit ${shortRef} contains manual conflict resolutions (${evilFiles.join(', ')}) that would be lost when linearizing history for the public fork. Rebase '${branch}' onto upstream/${defaultBranch} (dropping merges) and retry.`
      );
    }
  }
}

/** Result of rebuilding a branch as a linear head on `upstream/<default>`. */
interface RebuiltHead {
  head: string;
  /** Rebuilt commit id to the branch commit it was cherry-picked from. */
  originalOf: Map<string, string>;
  /** Managed commits left out of the rebuild. */
  dropped: string[];
}

/**
 * Rebuilds `branch` as a linear head on `base` (the commit id of
 * `refs/remotes/upstream/<defaultBranch>`) in a hooks-disabled worktree:
 * every non-merge, non-managed commit in `base..<sourceRef>` is
 * cherry-picked in topological order. Merge commits never ship; one with a manual conflict
 * resolution outside `.github/workflows/` is refused, since dropping it
 * would lose work.
 */
async function rebuildLinearHead(
  branch: string,
  sourceRef: string,
  base: string,
  defaultBranch: string,
  preserve: string[],
  repoDir: string
): Promise<RebuiltHead> {
  const ref = sourceRef;
  await assertNoEvilMerges(ref, branch, base, defaultBranch, repoDir);

  return withDetachedWorktree(
    repoDir,
    base,
    'venfork-stage-',
    async (tempDir, hooksDir) => {
      // --topo-order: committer dates can be skewed, and parents must be
      // picked before their children.
      const revListResult = await $({
        cwd: repoDir,
      })`git rev-list --reverse --topo-order --no-merges ${`${base}..${ref}`}`;
      const branchCommits = revListResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const commitsToPick: string[] = [];
      const dropped: Array<{ commit: string; kind: ManagedCommitKind }> = [];
      for (const commit of branchCommits) {
        const kind = await classifyManagedCommit(commit, repoDir, preserve);
        if (kind === null) commitsToPick.push(commit);
        else dropped.push({ commit, kind });
      }
      if (dropped.length > 0) {
        p.log.warn(
          `Dropping ${dropped.length} venfork-managed commit(s) from '${branch}':\n${dropped
            .map(({ commit, kind }) => `  - ${commit.slice(0, 12)} (${kind})`)
            .join('\n')}`
        );
      }

      const originalOf = new Map<string, string>();
      for (const commit of commitsToPick) {
        const pickResult = await $({
          cwd: tempDir,
          reject: false,
        })`git -c core.hooksPath=${hooksDir} cherry-pick --allow-empty ${commit}`;
        if (pickResult.exitCode !== 0) {
          await $({
            cwd: tempDir,
            reject: false,
          })`git cherry-pick --abort`;
          const touched = (await changedFilesInCommit(commit, repoDir)).filter(
            (file) => preserve.includes(file)
          );
          if (touched.length > 0) {
            throw new VenforkError(
              `Failed to stage '${branch}': commit ${commit.slice(0, 9)} changes preserved mirror-only path(s) ${touched.join(', ')}, which do not exist on upstream/${defaultBranch}. Move those changes to the mirror default branch (they cannot go upstream), drop them from '${branch}', and retry.`,
              'stage-leak'
            );
          }
          const reason =
            pickResult.stderr.trim() ||
            pickResult.stdout.trim() ||
            `exit ${pickResult.exitCode}`;
          throw new GitError(
            `Failed to stage '${branch}': cherry-picking ${commit} onto upstream/${defaultBranch} failed:\n${reason}\nRebase '${branch}' on upstream/${defaultBranch} and retry.`,
            'git cherry-pick'
          );
        }
        const picked = (
          await $({ cwd: tempDir })`git rev-parse HEAD`
        ).stdout.trim();
        originalOf.set(picked, commit);
      }

      const headResult = await $({ cwd: tempDir })`git rev-parse HEAD`;
      return {
        head: headResult.stdout.trim(),
        originalOf,
        dropped: dropped.map(({ commit }) => commit),
      };
    }
  );
}

/**
 * State needed to stage a branch, computed before any user confirmation so
 * the caller can show a preview and reuse it for the push and any follow-on
 * work (e.g. opening an upstream PR).
 *
 * `pushRemote` is the remote we push the staged branch to: `'public'` in the
 * standard 3-remote layout, `'upstream'` in `--own-upstream` mode (where the
 * branch lands directly on upstream as a same-repo PR head).
 */
export interface StagingPlan {
  branch: string;
  /** URL of the remote we push the staged branch to (`public` or `upstream`). */
  pushUrl: string;
  /** `owner/name` of the remote we push to. */
  pushRepoPath: string;
  /** Owner segment of `pushRepoPath`, used as the cross-repo head prefix when the PR head is in a different repo than the base. */
  pushOwner: string;
  /** `'public'` or `'upstream'`: which git remote name to push to. */
  pushRemote: 'public' | 'upstream';
  upstreamUrl: string;
  upstreamRepoPath: string;
  upstreamDefaultBranch: string;
  /**
   * Commit id of `refs/remotes/upstream/<upstreamDefaultBranch>`. The gate,
   * the rebuild and the preview all use this id: a local branch or tag
   * named `upstream/<default>` would shadow the short name.
   */
  upstreamTip: string;
  /** Mirror-only paths from the preserve allowlist. */
  preserve: string[];
  /** True when the head and base of the upstream PR live in the same repo (no-public mode). */
  noPublic: boolean;
  /** Upstream and public fork URLs from the config and the remotes. */
  recordedUrls: string[];
  /** Commit id stage rebuilds: `refs/heads/<branch>` read once at plan time, or the pinned commit. */
  sourceRef: string;
  /** Commit id recorded as `shippedBranches[branch].sourceHead`; equals `sourceRef`. */
  sourceHead: string;
  /** The approval gate result, or null when the mirror's level is `off`. */
  approval: ApprovalReport | null;
  /** The approved mirror PR; the upstream PR body comes from it. Null when the gate did not pass. */
  approvedPrNumber: number | null;
  /** The mirror's approval level. */
  approvalLevel: ApprovalLevel;
  /** A lowered approval level a person must confirm at a terminal first. */
  weakening: Weakening | null;
}

/** What the approval gate decided, as `--json` reports it. */
export interface ApprovalReport {
  level: GateLevel;
  /** False only in a dry run: a real stage throws instead. */
  ok: boolean;
  /** The mirror PR the gate read. */
  prUrl?: string;
  /** The approved PR head; stage ships exactly this commit. */
  headSha?: string;
  /** Logins whose approval counted. */
  approvers?: string[];
  /** True when `--force` stages past a refusal; the bypass is recorded on the mirror PR. */
  bypassed?: boolean;
  /** Number of the mirror PR the gate read. */
  prNumber?: number;
  /** Why a real stage would be refused. */
  reason?: ApprovalRefusal | 'precondition';
  /** The refusal a real stage would print. */
  message?: string;
}

function stageConfirmMessage(noPublic: boolean, createPr: boolean): string {
  if (noPublic) {
    return createPr ? 'Push to upstream and open the PR?' : 'Push to upstream?';
  }
  return createPr
    ? 'Push to public fork and open the upstream PR?'
    : 'Push to public fork?';
}

function notGitHubForPr(remote: string): PreconditionError {
  return new PreconditionError(
    `Cannot open an upstream PR: ${remote} is not a GitHub repository.`,
    { hint: 'Pass --no-pr to push the branch only.' }
  );
}

/**
 * Resolves remotes and the default branch for a staging push, fetches
 * upstream and origin, and refuses branches that are not upstream work:
 * `venfork-config`, anything that is not a local branch, upstream's default
 * branch, and a branch with no history in common with upstream. Also
 * refuses while the config holds invalid preserve entries, as sync does.
 * Refuses before the fetch when the push confirm could not be answered,
 * unless this is a dry run, which never confirms, and when the PR is
 * wanted but upstream or the push remote is not on GitHub.
 * Throws `BranchNotFoundError` / `RemoteNotFoundError` so callers can render
 * a single failure path.
 */
async function planStaging(
  requested: string,
  cwd: string,
  consent: {
    createPr: boolean;
    dryRun?: boolean;
    prompt?: PromptContext;
    internalPrNumber?: number;
    force?: boolean;
  },
  source?: { sha: string }
): Promise<StagingPlan> {
  const branch = requested.replace(/^refs\/heads\//, '');
  if (branch.replace(/^origin\//, '') === CONFIG_BRANCH) {
    throw new PreconditionError(
      `Refusing to stage '${branch}': it holds venfork's private configuration, not upstream work.`
    );
  }
  assertNoMirrorReference(branch, 'the branch name', await mirrorDenyList(cwd));
  let { sourceRef, sourceHead } = source
    ? await pinnedSource(branch, source.sha, cwd)
    : await localBranchSource(branch, cwd);

  const config = await readVenforkConfigFromRepo(cwd);
  assertNoInvalidPreserve(config);
  const level = approvalOf(config);
  const noPublic = config?.mode === 'no-public';

  const upstreamUrlResult = await $({
    cwd,
    reject: false,
  })`git remote get-url upstream`;
  if (upstreamUrlResult.exitCode !== 0) {
    throw new RemoteNotFoundError('upstream');
  }
  const upstreamUrl = upstreamUrlResult.stdout.trim();
  const upstreamRepoPath = parseRepoPath(upstreamUrl);

  let pushUrl: string;
  let pushRepoPath: string;
  let pushRemote: 'public' | 'upstream';
  if (noPublic) {
    pushUrl = upstreamUrl;
    pushRepoPath = upstreamRepoPath;
    pushRemote = 'upstream';
  } else {
    const publicUrlResult = await $({
      cwd,
      reject: false,
    })`git remote get-url public`;
    if (publicUrlResult.exitCode !== 0) {
      throw new RemoteNotFoundError('public');
    }
    pushUrl = publicUrlResult.stdout.trim();
    pushRepoPath = parseRepoPath(pushUrl);
    pushRemote = 'public';
  }
  const pushOwner = pushRepoPath.split('/')[0] ?? '';

  if (!consent.dryRun) {
    assertCanConfirm(
      stageConfirmMessage(noPublic, consent.createPr),
      consent.prompt,
      NOT_STAGED
    );
  }
  if (consent.createPr && !upstreamRepoPath) {
    throw notGitHubForPr(`the upstream remote '${upstreamUrl}'`);
  }
  if (consent.createPr && !pushRepoPath) {
    throw notGitHubForPr(`the ${pushRemote} remote '${pushUrl}'`);
  }
  await netFetch('upstream', cwd);
  await netFetch('origin', cwd);
  const weakening = await findWeakening(level, cwd);
  if (
    weakening &&
    !consent.dryRun &&
    !canPrompt({ noInput: consent.prompt?.noInput ?? false })
  ) {
    throw weakenedError(level, weakening);
  }
  let approval: ApprovalReport | null = null;
  let approvedPrNumber: number | null = null;
  if (level !== 'off') {
    const gate = await approvalGate(level, branch, sourceHead, cwd, consent);
    approval = gate.report;
    approvedPrNumber = gate.prNumber ?? null;
    if (
      approval.bypassed &&
      !canPrompt({ noInput: consent.prompt?.noInput ?? false })
    ) {
      throw new ApprovalError(
        'bypass-unconfirmed',
        `Not staged: --force needs a person to confirm the bypass at a terminal (${approval.message ?? approval.reason}).`,
        'Run the same stage at a terminal without --json and answer the confirm; --yes does not answer it.',
        { level, prUrl: approval.prUrl }
      );
    }
    if (approval.ok && approval.headSha) {
      sourceRef = approval.headSha;
      sourceHead = approval.headSha;
    }
  }
  const upstreamDefaultBranch = await getDefaultBranch('upstream', cwd);
  const upstreamTip = await resolveCommit(
    `refs/remotes/upstream/${upstreamDefaultBranch}`,
    cwd
  );
  if (!upstreamTip) {
    throw new PreconditionError(
      `upstream/${upstreamDefaultBranch} not found after fetch. Check the upstream remote and the default branch name.`
    );
  }
  if (branch === upstreamDefaultBranch) {
    throw new PreconditionError(
      `Refusing to stage '${branch}': it is upstream's default branch, and staging it would overwrite ${branch} on ${noPublic ? 'upstream' : 'the public fork'}. Stage a feature branch instead.`
    );
  }
  await assertPreserveEntriesAreNotDirectories(
    config?.preserve ?? [],
    [
      `refs/remotes/origin/${upstreamDefaultBranch}`,
      `refs/heads/${upstreamDefaultBranch}`,
    ],
    cwd
  );
  const mergeBase = await $({
    cwd,
    reject: false,
  })`git merge-base ${upstreamTip} ${sourceRef}`;
  if (mergeBase.exitCode === 1) {
    throw new PreconditionError(
      `Refusing to stage '${branch}': it has no history in common with upstream/${upstreamDefaultBranch}.`
    );
  }
  if (mergeBase.exitCode !== 0) {
    throw new GitError(
      `Cannot find where '${branch}' meets upstream/${upstreamDefaultBranch}: ${mergeBase.stderr.trim()}`,
      'git merge-base'
    );
  }

  return {
    branch,
    pushUrl,
    pushRepoPath,
    pushOwner,
    pushRemote,
    upstreamUrl,
    upstreamRepoPath,
    upstreamDefaultBranch,
    upstreamTip,
    preserve: config?.preserve ?? [],
    noPublic,
    recordedUrls: [
      ...new Set(
        [
          config?.upstreamUrl,
          config?.publicForkUrl,
          upstreamUrl,
          noPublic ? undefined : pushUrl,
        ].filter((url): url is string => Boolean(url))
      ),
    ],
    sourceRef,
    sourceHead,
    approval,
    approvedPrNumber,
    approvalLevel: level,
    weakening,
  };
}

function weakenedError(
  level: ApprovalLevel,
  weakening: Weakening
): ApprovalError {
  return new ApprovalError(
    'gate-weakened',
    `Not staged: the approval gate was lowered (${describeWeakening(weakening)}), and a person must confirm that at a terminal.`,
    'Run the same stage at a terminal without --json and answer the confirm; --yes does not answer it.',
    { level, weakened: weakening }
  );
}

/**
 * Asks a person at a terminal to confirm a lowered approval level. Unlike
 * the push confirm, `--yes` never answers it.
 */
async function confirmWeakening(
  plan: StagingPlan,
  prompt: PromptContext | undefined
): Promise<void> {
  if (!plan.weakening) return;
  p.log.warn(describeWeakening(plan.weakening));
  const answer = await promptConfirm(
    {
      message: `The approval gate was lowered. Stage '${plan.branch}' with approval ${plan.approvalLevel}?`,
      initialValue: false,
      stopped: NOT_STAGED,
    },
    { yes: false, noInput: prompt?.noInput ?? false }
  );
  if (isCancel(answer)) {
    p.cancel('Operation cancelled');
    throw new CommandExitError(130);
  }
  if (!answer) {
    p.outro('Stage cancelled');
    throw new CommandExitError(0);
  }
}

/**
 * Runs the approval gate and checks that the commit stage would rebuild is
 * the approved mirror PR head. A dry run reports a refusal instead of
 * throwing it.
 */
async function approvalGate(
  level: GateLevel,
  branch: string,
  sourceHead: string,
  cwd: string,
  consent: { dryRun?: boolean; internalPrNumber?: number; force?: boolean }
): Promise<{ report: ApprovalReport; prNumber?: number }> {
  try {
    const pass = await checkApprovalGate({
      level,
      mirror: await findMirrorRepoPath(cwd),
      branch,
      cwd,
      pinnedPr: consent.internalPrNumber,
    });
    if (pass.headSha !== sourceHead) {
      throw branchMovedError(level, branch, sourceHead, pass);
    }
    return {
      report: {
        level,
        ok: true,
        prUrl: pass.prUrl,
        prNumber: pass.prNumber,
        headSha: pass.headSha,
        approvers: pass.approvers,
      },
      prNumber: pass.prNumber,
    };
  } catch (error) {
    if (
      consent.force &&
      error instanceof ApprovalError &&
      error.reason !== 'branch-moved'
    ) {
      return { report: forcedReport(level, branch, error, sourceHead) };
    }
    if (!consent.dryRun) throw error;
    if (error instanceof ApprovalError) {
      const prUrl = error.details?.prUrl;
      return {
        report: {
          level,
          ok: false,
          reason: error.reason,
          message: errorLine(error),
          ...(typeof prUrl === 'string' && prUrl ? { prUrl } : {}),
        },
      };
    }
    if (error instanceof PreconditionError) {
      return {
        report: {
          level,
          ok: false,
          reason: 'precondition',
          message: errorLine(error),
        },
      };
    }
    throw error;
  }
}

function branchMovedError(
  level: GateLevel,
  branch: string,
  sourceHead: string,
  pr: { prUrl: string; prNumber: number; headSha: string }
): ApprovalError {
  return new ApprovalError(
    'branch-moved',
    `Not staged: '${branch}' is at ${sourceHead.slice(0, 12)}, but the approved PR head is ${pr.headSha.slice(0, 12)}.`,
    `Push '${branch}' and get the new head approved, or check out the approved commit.`,
    {
      level,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      headSha: pr.headSha,
      branchHead: sourceHead,
    }
  );
}

/**
 * The report for a `--force` stage past `error`. A refusal with no open
 * mirror PR is not bypassable: the bypass must be recorded on one. Nor is
 * a branch whose head is not the mirror PR head.
 */
function forcedReport(
  level: GateLevel,
  branch: string,
  error: ApprovalError,
  sourceHead: string
): ApprovalReport {
  const prUrl = error.details?.prUrl;
  const prNumber = error.details?.prNumber;
  const prHead = error.details?.headSha;
  if (typeof prUrl !== 'string' || typeof prNumber !== 'number') {
    throw new ApprovalError(
      error.reason,
      error.message,
      '--force records the bypass on the mirror PR, so push the branch and open one first.',
      error.details
    );
  }
  if (typeof prHead === 'string' && prHead !== sourceHead) {
    throw branchMovedError(level, branch, sourceHead, {
      prUrl,
      prNumber,
      headSha: prHead,
    });
  }
  return {
    level,
    ok: false,
    bypassed: true,
    reason: error.reason,
    message: errorLine(error),
    prUrl,
    prNumber,
    headSha: sourceHead,
  };
}

async function recordBypass(
  plan: StagingPlan,
  cwd: string,
  s: ReturnType<typeof p.spinner>
): Promise<void> {
  const report = plan.approval;
  const mirror = await findMirrorRepoPath(cwd);
  if (!report?.prUrl || report.prNumber === undefined || !mirror) {
    throw new PreconditionError(
      'Not staged: venfork could not record the --force bypass, because origin is not a GitHub repository or the mirror PR is unknown.'
    );
  }
  s.start('Recording the --force bypass on the mirror PR');
  await recordBypassOnMirrorPr({
    mirror,
    prNumber: report.prNumber,
    prUrl: report.prUrl,
    login: await ghLogin(cwd),
    level: report.level,
    sourceHead: plan.sourceHead,
    refusal: report.message ?? String(report.reason),
    cwd,
  });
  s.stop(`Bypass recorded on ${report.prUrl}`);
}

/**
 * Asks a person at a terminal to confirm a `--force` bypass of the gate.
 * `--yes` never answers it.
 */
async function confirmBypass(
  plan: StagingPlan,
  prompt: PromptContext | undefined
): Promise<void> {
  const report = plan.approval;
  if (!report?.bypassed) return;
  p.log.warn(`--force: ${report.message ?? report.reason}`);
  const answer = await promptConfirm(
    {
      message: `Bypass the approval gate (${report.level}) and stage '${plan.branch}' at ${plan.sourceHead.slice(0, 12)}? The bypass is recorded on ${report.prUrl}.`,
      initialValue: false,
      stopped: NOT_STAGED,
    },
    { yes: false, noInput: prompt?.noInput ?? false }
  );
  if (isCancel(answer)) {
    p.cancel('Operation cancelled');
    throw new CommandExitError(130);
  }
  if (!answer) {
    p.outro('Stage cancelled');
    throw new CommandExitError(0);
  }
}

function approvalLine(report: ApprovalReport): string {
  if (report.bypassed) {
    return `${report.level}, bypassed with --force (${report.reason}); recorded on ${report.prUrl}`;
  }
  if (!report.ok) return `${report.level}, not met (${report.reason})`;
  return `${report.level}, approved by ${(report.approvers ?? []).join(', ')} on ${report.prUrl} at ${(report.headSha ?? '').slice(0, 12)}`;
}

function errorLine(error: VenforkError): string {
  return error.hint ? `${error.message} ${error.hint}` : error.message;
}

/**
 * The commit id of the local branch `refs/heads/<branch>`, read once so a
 * branch moved during the fetches cannot change what ships. Refuses tags,
 * remote refs and a missing branch.
 */
async function localBranchSource(
  branch: string,
  cwd: string
): Promise<{ sourceRef: string; sourceHead: string }> {
  const branchCheck = await $({
    cwd,
    reject: false,
  })`git rev-parse --verify --quiet refs/heads/${branch}`;
  if (branchCheck.exitCode !== 0) {
    const anyRef = await $({
      cwd,
      reject: false,
    })`git rev-parse --verify --quiet ${branch}`;
    if (anyRef.exitCode === 0) {
      throw new PreconditionError(
        `Refusing to stage '${branch}': it is not a local branch. Tags and remote-tracking refs cannot be staged; check out a branch and stage that.`
      );
    }
    throw new BranchNotFoundError(branch);
  }
  const sha = branchCheck.stdout.trim();
  return { sourceRef: sha, sourceHead: sha };
}

/**
 * The commit `sha`, staged under the name `branch` without reading any
 * local branch. Refuses an abbreviated id, a name git does not accept as a
 * branch, and a commit missing from the clone.
 */
async function pinnedSource(
  branch: string,
  sha: string,
  cwd: string
): Promise<{ sourceRef: string; sourceHead: string }> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new PreconditionError(
      `Refusing to stage '${branch}': '${sha}' is not a full commit id.`
    );
  }
  const refFormat = await $({
    cwd,
    reject: false,
  })`git check-ref-format ${`refs/heads/${branch}`}`;
  if (refFormat.exitCode !== 0) {
    throw new PreconditionError(
      `Refusing to stage '${branch}': it is not a valid branch name.`
    );
  }
  const present = await $({
    cwd,
    reject: false,
  })`git cat-file -e ${`${sha}^{commit}`}`;
  if (present.exitCode !== 0) {
    throw new PreconditionError(
      `Refusing to stage '${branch}': commit ${sha} is not in this clone. Fetch it and retry.`
    );
  }
  return { sourceRef: sha, sourceHead: sha };
}

/** A gated linear head ready to push, with what it publishes. */
interface PreparedStage {
  head: string;
  /** Subjects of the commits in `upstream/<default>..head`, oldest first. */
  subjects: string[];
  /** Output of `mirrorDenyList`, reused for the PR title and body. */
  denyList: string[];
  /** Paths some commit in `upstream/<default>..head` adds, modifies or retypes. */
  files: string[];
  /** Paths in `files` that are absent at `head` but still in its history. */
  removedLater: string[];
  /** Commits whose message mentions an issue or PR number (`#N`). */
  issueRefCommits: number;
}

/**
 * Rebuilds the branch as a linear head on `upstream/<default>` and runs
 * the per-commit gate over it. Nothing is pushed.
 */
async function prepareStage(
  plan: StagingPlan,
  cwd: string
): Promise<PreparedStage> {
  const base = plan.upstreamTip;
  const rebuilt = await rebuildLinearHead(
    plan.branch,
    plan.sourceRef,
    base,
    plan.upstreamDefaultBranch,
    plan.preserve,
    cwd
  );
  const denyList = await mirrorDenyList(cwd);
  const { blobs: mirrorBlobs, texts: mirrorTexts } = await collectMirrorBlobs(
    [
      `refs/remotes/origin/${plan.upstreamDefaultBranch}`,
      `refs/heads/${plan.upstreamDefaultBranch}`,
      ...rebuilt.dropped,
    ],
    plan.preserve,
    base,
    cwd
  );
  const files = await assertPublishableCommits({
    branch: plan.branch,
    base,
    head: rebuilt.head,
    preserve: plan.preserve,
    mirrorBlobs,
    mirrorTexts,
    denyList,
    recordedUrls: plan.recordedUrls,
    originalOf: rebuilt.originalOf,
    cwd,
  });
  const log = await $({
    cwd,
  })`git log --reverse --format=%s ${base}..${rebuilt.head}`;
  const messages = await $({
    cwd,
  })`git log --format=%B%x00 ${base}..${rebuilt.head}`;
  const atHead =
    files.length === 0
      ? ''
      : (
          await $({
            cwd,
          })`git --literal-pathspecs ls-tree -r -z --name-only ${rebuilt.head} -- ${files}`
        ).stdout;
  const present = new Set(atHead.split('\0').filter(Boolean));
  return {
    head: rebuilt.head,
    subjects: log.stdout.split('\n').filter(Boolean),
    denyList,
    files,
    removedLater: files.filter((file) => !present.has(file)),
    issueRefCommits: messages.stdout.split('\0').filter(mentionsIssueNumber)
      .length,
  };
}

/** True when `text` contains a `#N` issue or PR reference. */
function mentionsIssueNumber(text: string): boolean {
  return /#\d+\b/.test(text);
}

/**
 * Pushes the prepared head to the public fork (or upstream in no-public
 * mode) as `refs/heads/<branch>`, leased on the tip `ls-remote` reports and
 * without following tags.
 *
 * The caller owns the spinner so consistent UI text appears in every
 * command that stages.
 */
async function pushStagedHead(
  plan: StagingPlan,
  head: string,
  cwd: string,
  s: ReturnType<typeof p.spinner>
): Promise<void> {
  // In no-public mode the `upstream` remote's push URL is DISABLE; stage
  // opts in explicitly by pushing to the URL.
  const pushDest = plan.noPublic ? plan.pushUrl : plan.pushRemote;
  const target = plan.noPublic ? 'upstream' : 'public fork';
  const ref = `refs/heads/${plan.branch}`;

  s.start(`Pushing to ${target}`);
  const ls = await netExec(cwd, {
    bufferOutput: true,
  })`git ls-remote --exit-code ${pushDest} ${ref}`;
  if (ls.exitCode !== 0 && ls.exitCode !== 2) {
    throw new GitError(
      `Cannot read ${plan.branch} on the ${target}: ${netFailureReason(ls)}`,
      'git ls-remote'
    );
  }
  const expected =
    ls.exitCode === 0 ? ((ls.stdout ?? '').trim().split(/\s+/)[0] ?? '') : '';
  const push = await netExec(cwd, {
    bufferOutput: true,
  })`git push ${pushDest} ${head}:${ref} --force-with-lease=${ref}:${expected} --no-follow-tags`;
  if (push.exitCode !== 0) {
    const reason = netFailureReason(push);
    throw new GitError(
      /stale info/i.test(reason)
        ? `${plan.branch} on the ${target} moved while staging. Re-run \`venfork stage ${plan.branch}\`.`
        : `push to the ${target} failed: ${reason}`,
      `git push ${plan.pushRemote} ${plan.branch}`
    );
  }
  s.stop('Push successful');
}

export interface StageOptions {
  /** When true, also open an upstream PR after staging. The CLI sets it unless `--no-pr`. */
  createPr?: boolean;
  /** When true, the upstream PR is opened as a draft. Implies createPr. */
  draft?: boolean;
  /** Override the upstream PR title; default is the internal PR title. */
  title?: string;
  /** Override the upstream base branch; default is upstream's default branch. */
  base?: string;
  /**
   * Pin the internal review PR by number instead of letting `findInternalPr`
   * pick the most recent one for the branch.
   */
  internalPrNumber?: number;
  /**
   * When true, *don't* update an existing upstream PR's body if one is found
   * for the same head/base. Default behaviour (false) re-syncs the body via
   * `gh pr edit` so addressing internal feedback re-publishes upstream.
   */
  noUpdateExisting?: boolean;
  /**
   * Run every check and build the PR title and body, then stop before the
   * confirm: nothing is pushed, opened or recorded.
   */
  dryRun?: boolean;
  /** `--yes` / `--no-input` for the push confirm. */
  prompt?: PromptContext;
  /**
   * Stage past an approval gate refusal after a person confirms at a
   * terminal; the bypass is recorded as a comment on the mirror PR.
   */
  force?: boolean;
  /**
   * Stage the commit `sha` under the name `branch` instead of
   * `refs/heads/<branch>`, so no local branch is read or needed.
   */
  source?: { sha: string };
}

/**
 * The `venfork stage branch ...` command that repeats a stage with the same
 * PR flags, shell-quoted so it is safe to paste.
 */
export function stageRerunCommand(
  branch: string,
  createPr: boolean,
  options: StageOptions
): string {
  const parts = ['venfork stage branch', shellQuote(branch)];
  if (!createPr) parts.push('--no-pr');
  if (options.draft) parts.push('--draft');
  if (options.base !== undefined)
    parts.push('--base', shellQuote(options.base));
  if (options.title !== undefined) {
    parts.push('--title', shellQuote(options.title));
  }
  if (options.internalPrNumber !== undefined) {
    parts.push('--internal-pr', String(options.internalPrNumber));
  }
  if (options.noUpdateExisting) parts.push('--no-update-existing');
  return parts.join(' ');
}

/** `--json` result of `venfork stage <branch>`: a push, or a `--dry-run` preview. */
export type StageResult = StagePushResult | StageDryRunResult;

/** `--json` result of `venfork stage <branch> --dry-run`. Nothing was pushed. */
export interface StageDryRunResult {
  dryRun: true;
  branch: string;
  /** The preview rebuild's local commit. A real stage rebuilds again: new SHA, same tree. */
  head: string;
  /** The remote a real stage would push to. */
  target: 'public' | 'upstream';
  /** GitHub compare URL for the branch once it is pushed. */
  compareUrl: string;
  /** The upstream branch the PR would target. */
  base: string;
  /** Subjects of the commits that would be published, oldest first. */
  commits: string[];
  /** Paths the published history adds, modifies or retypes. */
  files: string[];
  /** Paths in `files` that are gone at `head` but stay in the history. */
  removedLater: string[];
  /** The upstream PR title after redaction. Absent with `--no-pr` or when `existingPrUrl` is set: a re-stage keeps that PR's title. */
  prTitle?: string;
  /** The upstream PR body after redaction. Absent with `--no-pr`, or with `existingPrUrl` and `--no-update-existing`. */
  prBody?: string;
  /** The open upstream PR a real stage would update instead of opening a new one. */
  existingPrUrl?: string;
  /** The internal review PR the body came from. */
  internalPrUrl?: string;
  /** The approval gate result; absent when the mirror's level is `off`. */
  approval?: ApprovalReport;
  /** The lowered approval level a real stage would ask a person to confirm. */
  weakened?: Weakening;
}

/** `--json` result of a `venfork stage <branch>` that pushed. */
export interface StagePushResult {
  branch: string;
  /** The rebuilt commit pushed as the branch. */
  head: string;
  /** The remote the branch was pushed to. */
  target: 'public' | 'upstream';
  /** GitHub compare URL for opening the PR by hand. */
  compareUrl: string;
  /**
   * Absent with `--no-pr`: `created`, `updated` (an open PR's body was
   * refreshed), `unchanged` (an open PR was left as is) or `failed`
   * (the push succeeded, the PR could not be opened or its body could
   * not be updated).
   */
  prAction?: 'created' | 'updated' | 'unchanged' | 'failed';
  /** The upstream PR, when stage opened or found one. */
  prUrl?: string;
  /** The internal review PR the upstream body came from. */
  internalPrUrl?: string;
  /** The approval that let the stage through; absent when the level is `off`. */
  approval?: ApprovalReport;
}

/**
 * Synthetic upstream PR body for when no internal review PR was found: one
 * bullet per published commit subject, with `#N` references dropped (they
 * would resolve against an unrelated upstream issue or PR): `(#N)` groups,
 * and `#N` after the start or whitespace and before the end, whitespace or
 * punctuation. `#N` inside a word or URL is kept. No SHAs, so nothing
 * points back at the mirror.
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function syntheticBody(subjects: readonly string[]): string {
  const lines = subjects
    .map((subject) =>
      subject
        .replace(/\s*\(#\d+\)/g, '')
        .replace(/(^|\s+)#\d+(?=$|\s|[.,;:!?)\]}"'])/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .map((subject) => `- ${subject}`);
  if (lines.length === 0) {
    return 'No description provided.';
  }
  return `Commits in this branch:\n\n${lines.join('\n')}`;
}

/**
 * Builds the upstream PR title and body: the internal PR's (or the override)
 * after redaction, else the branch name and a synthetic body. Both then go
 * through the deny-list scan, so nothing that names the mirror is published.
 */
function buildUpstreamPrPayload(
  branch: string,
  internal: InternalPrInfo | null,
  override: { title?: string },
  prepared: PreparedStage
): { title: string; body: string } {
  const title = translateInternalTitle(
    override.title ?? internal?.title ?? branch
  );
  const body = translateInternalBody(
    internal ? internal.body : syntheticBody(prepared.subjects)
  );
  assertNoMirrorReference(title, 'the upstream PR title', prepared.denyList);
  assertNoMirrorReference(body, 'the upstream PR body', prepared.denyList);
  return { title, body };
}

/**
 * Stage command: Push branch to public fork for PR to upstream.
 *
 * With `createPr` (the CLI default; `--no-pr` turns it off), also opens the upstream PR using the
 * internal-review PR's body as a starting point (with `<!-- venfork:internal
 * -->...<!-- /venfork:internal -->` blocks stripped) and records the
 * internal/upstream PR linkage in `venfork-config.shippedBranches`.
 * @returns What was staged, for `--json`.
 */
export async function stageCommand(
  branch: string | undefined,
  options: StageOptions = {}
): Promise<StageResult> {
  if (!branch) {
    throw new UsageError(`Missing branch name. Usage: ${STAGE_USAGE}`);
  }

  p.intro('📤 Venfork Stage');

  const createPr = Boolean(options.createPr || options.draft);

  const s = p.spinner();
  const repoDir = process.cwd();
  try {
    s.start('Verifying branch and fetching upstream and origin');
    const plan = await planStaging(
      branch,
      repoDir,
      {
        createPr,
        dryRun: options.dryRun,
        prompt: options.prompt,
        internalPrNumber: options.internalPrNumber,
        force: options.force,
      },
      options.source
    );
    s.stop('Branch verified');
    if (options.dryRun) {
      if (plan.weakening) {
        p.log.warn(
          `A real stage needs a person to confirm at a terminal: ${describeWeakening(plan.weakening)}`
        );
      }
    } else {
      await confirmWeakening(plan, options.prompt);
      await rememberApproval(repoDir, plan.approvalLevel);
      await confirmBypass(plan, options.prompt);
    }
    if (options.force && plan.approvalLevel === 'off') {
      p.log.warn('approval is off, so --force has nothing to bypass.');
    }
    if (plan.approval?.ok || plan.approval?.bypassed) {
      p.log.info(approvalLine(plan.approval));
    } else if (plan.approval) {
      p.log.warn(
        `A real stage would be refused: ${plan.approval.message ?? plan.approval.reason}`
      );
    }

    s.start('Rebuilding the branch on upstream and checking every commit');
    const prepared = await prepareStage(plan, repoDir);
    if (prepared.subjects.length === 0) {
      throw new PreconditionError(
        `Nothing to stage: '${plan.branch}' has no commits to publish beyond upstream/${plan.upstreamDefaultBranch} (merge commits and venfork-managed commits are dropped).`,
        { hint: 'Commit your work on the branch first.' }
      );
    }
    s.stop(`Prepared ${prepared.subjects.length} commit(s) to publish`);

    // Look up the internal PR up-front when the PR is wanted so the user sees the
    // translated body in the confirm prompt before anything is published.
    let internalPr: InternalPrInfo | null = null;
    let translatedBody = '';
    let prTitle = '';
    const baseBranch = options.base ?? plan.upstreamDefaultBranch;
    if (createPr) {
      s.start('Looking up internal review PR');
      const mirrorRepoPath = await findMirrorRepoPath(repoDir);
      if (mirrorRepoPath) {
        internalPr = await findInternalPr(
          mirrorRepoPath,
          plan.branch,
          repoDir,
          plan.approvedPrNumber ?? options.internalPrNumber
        );
      }
      s.stop(
        internalPr
          ? `Internal PR found: ${internalPr.url}`
          : 'No internal PR found - using synthetic body'
      );
      const payload = buildUpstreamPrPayload(
        plan.branch,
        internalPr,
        { title: options.title },
        prepared
      );
      prTitle = payload.title;
      translatedBody = payload.body;
    }

    const detailLines = plan.noPublic
      ? [
          `Branch '${plan.branch}' will be pushed directly to upstream.`,
          'This makes your work visible and ready for PR within upstream.',
          '',
          `  From: Private vendor repo (current)`,
          `  To:   ${plan.pushUrl}`,
          `  PR:   ${plan.upstreamRepoPath}@${plan.branch} → ${plan.upstreamRepoPath}`,
        ]
      : [
          `Branch '${plan.branch}' will be pushed to your public fork.`,
          'This makes your work visible and ready for PR to upstream.',
          '',
          `  From: Private vendor repo (current)`,
          `  To:   ${plan.pushUrl}`,
          `  PR:   ${plan.pushRepoPath} → ${plan.upstreamRepoPath}`,
        ];
    detailLines.push(
      '',
      `  Commits (${prepared.subjects.length}), rebuilt on upstream/${plan.upstreamDefaultBranch}:`,
      ...prepared.subjects.map((subject) => `    - ${subject}`),
      '',
      `  Files (${prepared.files.length}) published in history:`,
      ...prepared.files.map((file) =>
        prepared.removedLater.includes(file)
          ? `    - ${file} (removed later in the branch, still in history)`
          : `    - ${file}`
      )
    );
    if (prepared.issueRefCommits > 0) {
      p.log.warn(
        `${prepared.issueRefCommits} commit message(s) reference issue/PR numbers that will resolve against upstream`
      );
    }
    // A real stage keeps an open upstream PR's title and edits only its body.
    let existingPrUrl: string | null = null;
    if (createPr && options.dryRun) {
      s.start('Looking for an open upstream PR');
      const existing = await findOpenUpstreamPr({
        upstreamRepoPath: plan.upstreamRepoPath,
        headOwner: plan.pushOwner,
        branch: plan.branch,
        base: baseBranch,
        cwd: repoDir,
      });
      s.clear();
      if ('error' in existing) {
        p.log.warn(
          `Could not look for an open upstream PR (${existing.error}). The preview assumes a real stage opens a new one.`
        );
      } else {
        existingPrUrl = existing.url;
      }
    }
    const publishesTitle = createPr && !existingPrUrl;
    const publishesBody =
      createPr && (!existingPrUrl || !options.noUpdateExisting);

    if (publishesTitle && mentionsIssueNumber(prTitle)) {
      p.log.warn(
        'The upstream PR title references issue/PR numbers that will resolve against upstream'
      );
    }
    if (publishesBody && mentionsIssueNumber(translatedBody)) {
      p.log.warn(
        'The upstream PR body references issue/PR numbers that will resolve against upstream'
      );
    }
    if (createPr && existingPrUrl) {
      detailLines.push(
        '',
        `  Upstream PR: ${existingPrUrl} is already open; its title stays`,
        `  Body:        ${options.noUpdateExisting ? 'left unchanged (--no-update-existing)' : 'replaced with the preview below'}`
      );
    } else if (createPr) {
      detailLines.push(
        '',
        `  Upstream PR: ${prTitle}`,
        `  Base:        ${plan.upstreamRepoPath}@${baseBranch}`,
        `  Draft:       ${options.draft ? 'yes' : 'no'}`
      );
    }
    if (plan.approval) {
      detailLines.push('', `  Approval:    ${approvalLine(plan.approval)}`);
    }
    p.note(detailLines.join('\n'), 'Staging Details');

    if (publishesBody) {
      p.note(translatedBody || '(empty)', 'Upstream PR body preview');
    }

    // In no-public mode the head and base live in the same repo, so the
    // compare URL takes a bare branch name.
    const prUrl = plan.noPublic
      ? `https://github.com/${plan.upstreamRepoPath}/compare/${baseBranch}...${plan.branch}?expand=1`
      : `https://github.com/${plan.upstreamRepoPath}/compare/${baseBranch}...${plan.pushOwner}:${plan.branch}?expand=1`;

    if (options.dryRun) {
      p.outro(
        `Dry run: nothing was pushed. Run the same command without --dry-run to stage '${plan.branch}'.`
      );
      return {
        dryRun: true,
        branch: plan.branch,
        head: prepared.head,
        target: plan.pushRemote,
        compareUrl: prUrl,
        base: baseBranch,
        commits: prepared.subjects,
        files: prepared.files,
        removedLater: prepared.removedLater,
        ...(publishesTitle ? { prTitle } : {}),
        ...(publishesBody ? { prBody: translatedBody } : {}),
        ...(existingPrUrl ? { existingPrUrl } : {}),
        ...(internalPr ? { internalPrUrl: internalPr.url } : {}),
        ...(plan.approval ? { approval: plan.approval } : {}),
        ...(plan.weakening ? { weakened: plan.weakening } : {}),
      };
    }

    const shouldStage = await promptConfirm(
      {
        message: stageConfirmMessage(plan.noPublic, createPr),
        initialValue: false,
        stopped: NOT_STAGED,
      },
      options.prompt
    );

    if (isCancel(shouldStage)) {
      p.cancel('Operation cancelled');
      throw new CommandExitError(130);
    }

    if (!shouldStage) {
      p.outro('Stage cancelled');
      throw new CommandExitError(0);
    }

    if (plan.approval?.bypassed) {
      await recordBypass(plan, repoDir, s);
    }
    await pushStagedHead(plan, prepared.head, repoDir, s);
    const stagedHead = prepared.head;

    let upstreamPrUrl: string | undefined;
    let alreadyExisted = false;
    let prAction: StagePushResult['prAction'];
    if (createPr) {
      prAction = 'failed';
      s.start('Opening upstream pull request');
      try {
        const result = await createUpstreamPr({
          upstreamRepoPath: plan.upstreamRepoPath,
          headOwner: plan.pushOwner,
          sameRepoHead: plan.noPublic,
          branch: plan.branch,
          base: baseBranch,
          title: prTitle,
          body: translatedBody,
          draft: Boolean(options.draft),
          denyList: prepared.denyList,
          cwd: repoDir,
        });
        upstreamPrUrl = result.url;
        alreadyExisted = result.alreadyExists;
        prAction = alreadyExisted ? 'unchanged' : 'created';
        s.stop(
          alreadyExisted
            ? `Upstream PR already exists: ${upstreamPrUrl}`
            : `Upstream PR opened: ${upstreamPrUrl}`
        );
      } catch (err) {
        s.clear();
        const msg = err instanceof Error ? err.message : String(err);
        p.log.error(
          `The branch was pushed, but the upstream PR was not opened: ${msg}`
        );
      }

      // Refresh the existing upstream PR's body from the (possibly updated)
      // internal review. Default behaviour; opt out with --no-update-existing
      // if the user wants the upstream body frozen at first-stage time.
      if (alreadyExisted && upstreamPrUrl && !options.noUpdateExisting) {
        s.start('Updating existing upstream PR body');
        const editResult = await editUpstreamPrBody({
          prUrl: upstreamPrUrl,
          body: translatedBody,
          denyList: prepared.denyList,
          cwd: repoDir,
        });
        if (editResult.exitCode === 0) {
          prAction = 'updated';
          s.stop('Updated upstream PR body');
        } else {
          prAction = 'failed';
          s.clear();
          p.log.error(
            `The branch was pushed, but the upstream PR body was not updated: ${
              editResult.stderr.trim() ||
              `gh pr edit exit ${editResult.exitCode}`
            }`
          );
        }
      }
    }

    if (createPr && upstreamPrUrl) {
      try {
        await updateVenforkConfig(repoDir, {
          shippedBranches: {
            [plan.branch]: {
              upstreamPrUrl,
              head: stagedHead,
              shippedAt: new Date().toISOString(),
              sourceHead: plan.sourceHead,
              ...(internalPr ? { internalPrUrl: internalPr.url } : {}),
            },
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(`Could not record shippedBranches entry: ${msg}`);
      }
    }

    if (createPr && upstreamPrUrl) {
      const lines = [`Upstream PR: ${upstreamPrUrl}`];
      if (internalPr) {
        lines.push(`Internal review: ${internalPr.url}`);
      }
      p.note(lines.join('\n'), 'Next Steps');
    } else if (createPr) {
      p.note(
        plan.noPublic
          ? `Your branch is now on upstream, but the upstream PR was not opened.\n\nOpen it by hand:\n  ${prUrl}`
          : `Your branch is now on the public fork, but the upstream PR was not opened.\n\nOpen it by hand:\n  ${prUrl}`,
        'Next Steps'
      );
    } else {
      p.note(
        plan.noPublic
          ? `Your branch is now on upstream!\n\nCreate a pull request:\n  ${prUrl}\n\n(Tip: re-run without --no-pr to open it automatically.)`
          : `Your branch is now on the public fork!\n\nCreate a pull request to upstream:\n  ${prUrl}\n\n(Tip: re-run without --no-pr to open it automatically.)`,
        'Next Steps'
      );
    }

    p.outro(
      prAction === 'failed'
        ? `Stage incomplete: finish the PR by hand, or run \`${stageRerunCommand(plan.branch, createPr, options)}\` again.`
        : '✨ Stage complete!'
    );
    return {
      branch: plan.branch,
      head: stagedHead,
      target: plan.pushRemote,
      compareUrl: prUrl,
      ...(prAction ? { prAction } : {}),
      ...(upstreamPrUrl ? { prUrl: upstreamPrUrl } : {}),
      ...(internalPr ? { internalPrUrl: internalPr.url } : {}),
      ...(plan.approval ? { approval: plan.approval } : {}),
    };
  } catch (error) {
    throw p.reportFailure(error, s);
  }
}

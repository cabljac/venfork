import * as p from '@clack/prompts';
import { $ } from 'execa';
import { readVenforkConfigFromRepo, updateVenforkConfig } from '../config.js';
import {
  BranchNotFoundError,
  GitError,
  RemoteNotFoundError,
} from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { confirmOrAutoYes } from '../shared/confirm.js';
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
import { netExec, netFailureReason, netFetch } from '../shared/net.js';
import {
  findInternalPr,
  type InternalPrInfo,
  translateInternalBody,
  translateInternalTitle,
} from '../shared/redaction.js';
import { findMirrorRepoPath } from '../shared/repo.js';
import {
  assertPublishableCommits,
  collectMirrorBlobs,
} from '../shared/stage-gate.js';
import { withDetachedWorktree } from '../shared/worktree.js';
import { parseRepoPath } from '../utils.js';

const CONFIG_BRANCH = 'venfork-config';

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
    throw new Error(`Failed to inspect merge commit ${ref}: ${gitError}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function assertNoEvilMerges(
  ref: string,
  branch: string,
  defaultBranch: string,
  cwd: string
): Promise<void> {
  const mergeListResult = await $({
    cwd,
  })`git rev-list --merges upstream/${defaultBranch}..${ref}`;
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
      throw new Error(
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
 * Rebuilds `branch` as a linear head on `upstream/<defaultBranch>` in a
 * hooks-disabled worktree: every non-merge, non-managed commit in
 * `upstream/<defaultBranch>..refs/heads/<branch>` is cherry-picked in
 * topological order. Merge commits never ship; one with a manual conflict
 * resolution outside `.github/workflows/` is refused, since dropping it
 * would lose work.
 */
async function rebuildLinearHead(
  branch: string,
  defaultBranch: string,
  preserve: string[],
  repoDir: string
): Promise<RebuiltHead> {
  const ref = `refs/heads/${branch}`;
  await assertNoEvilMerges(ref, branch, defaultBranch, repoDir);

  return withDetachedWorktree(
    repoDir,
    `upstream/${defaultBranch}`,
    'venfork-stage-',
    async (tempDir, hooksDir) => {
      // --topo-order: committer dates can be skewed, and parents must be
      // picked before their children.
      const revListResult = await $({
        cwd: repoDir,
      })`git rev-list --reverse --topo-order --no-merges upstream/${defaultBranch}..${ref}`;
      const branchCommits = revListResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const commitsToPick: string[] = [];
      const dropped: Array<{ commit: string; kind: ManagedCommitKind }> = [];
      for (const commit of branchCommits) {
        const kind = await classifyManagedCommit(commit, repoDir);
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
            throw new Error(
              `Failed to stage '${branch}': commit ${commit.slice(0, 9)} changes preserved mirror-only path(s) ${touched.join(', ')}, which do not exist on upstream/${defaultBranch}. Move those changes to the mirror default branch (they cannot go upstream), drop them from '${branch}', and retry.`
            );
          }
          throw new Error(
            `Failed to stage '${branch}' because cherry-picking ${commit} onto upstream/${defaultBranch} caused conflicts. Rebase '${branch}' on upstream/${defaultBranch} and retry.`
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
 * standard 3-remote layout, `'upstream'` in `--no-public` mode (where the
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
  /** Mirror-only paths from the preserve allowlist. */
  preserve: string[];
  /** True when the head and base of the upstream PR live in the same repo (no-public mode). */
  noPublic: boolean;
}

/**
 * Resolves remotes and the default branch for a staging push, fetches
 * upstream and origin, and refuses branches that are not upstream work:
 * `venfork-config`, anything that is not a local branch, upstream's default
 * branch, and a branch with no history in common with upstream. Throws
 * `BranchNotFoundError` / `RemoteNotFoundError` so callers can render a
 * single failure path.
 */
async function planStaging(
  requested: string,
  cwd: string
): Promise<StagingPlan> {
  const branch = requested.replace(/^refs\/heads\//, '');
  if (branch.replace(/^origin\//, '') === CONFIG_BRANCH) {
    throw new Error(
      `Refusing to stage '${branch}': it holds venfork's private configuration, not upstream work.`
    );
  }
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
      throw new Error(
        `Refusing to stage '${branch}': it is not a local branch. Tags and remote-tracking refs cannot be staged; check out a branch and stage that.`
      );
    }
    throw new BranchNotFoundError(branch);
  }

  const config = await readVenforkConfigFromRepo(cwd);
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

  await netFetch('upstream', cwd);
  await netFetch('origin', cwd);
  const upstreamDefaultBranch = await getDefaultBranch('upstream');
  if (branch === upstreamDefaultBranch) {
    throw new Error(
      `Refusing to stage '${branch}': it is upstream's default branch, and staging it would overwrite ${branch} on ${noPublic ? 'upstream' : 'the public fork'}. Stage a feature branch instead.`
    );
  }
  const mergeBase = await $({
    cwd,
    reject: false,
  })`git merge-base ${`upstream/${upstreamDefaultBranch}`} ${`refs/heads/${branch}`}`;
  if (mergeBase.exitCode === 1) {
    throw new Error(
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
    preserve: [...(config?.preserve ?? []), ...(config?.invalidPreserve ?? [])],
    noPublic,
  };
}

/** A gated linear head ready to push, with what it publishes. */
interface PreparedStage {
  head: string;
  /** Subjects of the commits in `upstream/<default>..head`, oldest first. */
  subjects: string[];
  /** Output of `mirrorDenyList`, reused for the PR title and body. */
  denyList: string[];
}

/**
 * Rebuilds the branch as a linear head on `upstream/<default>` and runs
 * the per-commit gate over it. Nothing is pushed.
 */
async function prepareStage(
  plan: StagingPlan,
  cwd: string
): Promise<PreparedStage> {
  const base = `upstream/${plan.upstreamDefaultBranch}`;
  const rebuilt = await rebuildLinearHead(
    plan.branch,
    plan.upstreamDefaultBranch,
    plan.preserve,
    cwd
  );
  const denyList = await mirrorDenyList(cwd);
  const mirrorBlobs = await collectMirrorBlobs(
    [
      `refs/remotes/origin/${plan.upstreamDefaultBranch}`,
      `refs/heads/${plan.upstreamDefaultBranch}`,
      ...rebuilt.dropped,
    ],
    plan.preserve,
    base,
    cwd
  );
  await assertPublishableCommits({
    branch: plan.branch,
    base,
    head: rebuilt.head,
    preserve: plan.preserve,
    mirrorBlobs,
    denyList,
    originalOf: rebuilt.originalOf,
    cwd,
  });
  const log = await $({
    cwd,
  })`git log --reverse --format=%s ${base}..${rebuilt.head}`;
  return {
    head: rebuilt.head,
    subjects: log.stdout.split('\n').filter(Boolean),
    denyList,
  };
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
  /** When true, also open an upstream PR after staging. */
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
}

/**
 * Synthetic upstream PR body for when no internal review PR was found: one
 * bullet per published commit subject, with any trailing `(#N)` reference
 * dropped (it would point at a mirror PR number). No SHAs, so nothing points
 * back at the mirror.
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function syntheticBody(subjects: readonly string[]): string {
  const lines = subjects
    .map((subject) => subject.replace(/(\s*\(#\d+\))+\s*$/, '').trim())
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
 * Creates the upstream PR via gh and returns its URL. Surfaces the duplicate-PR
 * case ("already exists") cleanly so the caller can recover.
 */
async function createUpstreamPr(args: {
  upstreamRepoPath: string;
  /** Owner where the head branch lives. Same as upstream owner in no-public mode. */
  headOwner: string;
  /** True when head and base live in the same repo (no-public mode) — gh wants a bare branch name in that case, not `owner:branch`. */
  sameRepoHead: boolean;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  cwd: string;
}): Promise<{ url: string; alreadyExists: boolean }> {
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
 * Stage command: Push branch to public fork for PR to upstream.
 *
 * With `--pr` (createPr), additionally opens the upstream PR using the
 * internal-review PR's body as a starting point (with `<!-- venfork:internal
 * -->...<!-- /venfork:internal -->` blocks stripped) and records the
 * internal/upstream PR linkage in `venfork-config.shippedBranches`.
 */
export async function stageCommand(
  branch: string | undefined,
  options: StageOptions = {}
): Promise<void> {
  p.intro('📤 Venfork Stage');

  if (!branch) {
    p.log.error('Branch name is required');
    p.outro(
      'Usage: venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>]. Run `venfork stage --help` for every option.'
    );
    process.exit(1);
  }

  const createPr = Boolean(options.createPr || options.draft);

  const s = p.spinner();
  const repoDir = process.cwd();

  try {
    s.start('Verifying branch and fetching upstream and origin');
    const plan = await planStaging(branch, repoDir);
    s.stop('Branch verified');
    if (createPr) {
      if (!plan.upstreamRepoPath) {
        throw new Error(
          `Cannot open an upstream PR: the upstream remote '${plan.upstreamUrl}' is not a GitHub repository.`
        );
      }
      if (!plan.pushRepoPath) {
        throw new Error(
          `Cannot open an upstream PR: the ${plan.pushRemote} remote '${plan.pushUrl}' is not a GitHub repository.`
        );
      }
    }

    s.start('Rebuilding the branch on upstream and checking every commit');
    const prepared = await prepareStage(plan, repoDir);
    s.stop(`Prepared ${prepared.subjects.length} commit(s) to publish`);

    // Look up the internal PR up-front when --pr is set so the user sees the
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
          options.internalPrNumber
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
      ...prepared.subjects.map((subject) => `    - ${subject}`)
    );
    if (createPr) {
      detailLines.push(
        '',
        `  Upstream PR: ${prTitle}`,
        `  Base:        ${plan.upstreamRepoPath}@${baseBranch}`,
        `  Draft:       ${options.draft ? 'yes' : 'no'}`
      );
    }
    p.note(detailLines.join('\n'), 'Staging Details');

    if (createPr) {
      p.note(translatedBody || '(empty)', 'Upstream PR body preview');
    }

    const shouldStage = await confirmOrAutoYes({
      message: plan.noPublic
        ? createPr
          ? 'Push to upstream and open the PR?'
          : 'Push to upstream?'
        : createPr
          ? 'Push to public fork and open the upstream PR?'
          : 'Push to public fork?',
      initialValue: false,
      allowNonInteractive: createPr,
    });

    if (p.isCancel(shouldStage)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (!shouldStage) {
      p.outro('Stage cancelled');
      process.exit(0);
    }

    await pushStagedHead(plan, prepared.head, repoDir, s);
    const stagedHead = prepared.head;

    let upstreamPrUrl: string | undefined;
    let alreadyExisted = false;
    if (createPr) {
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
          cwd: repoDir,
        });
        upstreamPrUrl = result.url;
        alreadyExisted = result.alreadyExists;
        s.stop(
          alreadyExisted
            ? `Upstream PR already exists: ${upstreamPrUrl}`
            : `Upstream PR opened: ${upstreamPrUrl}`
        );
      } catch (err) {
        s.stop('Upstream PR creation failed');
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(msg);
        p.log.warn(
          'Staging succeeded; you can retry the PR manually with `gh pr create`.'
        );
      }

      // Refresh the existing upstream PR's body from the (possibly updated)
      // internal review. Default behaviour; opt out with --no-update-existing
      // if the user wants the upstream body frozen at first-stage time.
      if (alreadyExisted && upstreamPrUrl && !options.noUpdateExisting) {
        s.start('Updating existing upstream PR body');
        const editResult = await $({
          cwd: repoDir,
          reject: false,
          input: translatedBody,
        })`gh pr edit ${upstreamPrUrl} --body-file -`;
        if (editResult.exitCode === 0) {
          s.stop('Updated upstream PR body');
        } else {
          s.stop('Could not update upstream PR body');
          p.log.warn(
            editResult.stderr.trim() || `gh pr edit exit ${editResult.exitCode}`
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
              ...(internalPr ? { internalPrUrl: internalPr.url } : {}),
            },
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(`Could not record shippedBranches entry: ${msg}`);
      }
    }

    // Use the resolved baseBranch (which respects --base) so the compare URL
    // points at the same base the user asked for, even if --pr wasn't set
    // or `gh pr create` failed earlier. In no-public mode the head and base
    // live in the same repo, so gh's compare URL accepts a bare branch name.
    const prUrl = plan.noPublic
      ? `https://github.com/${plan.upstreamRepoPath}/compare/${baseBranch}...${plan.branch}?expand=1`
      : `https://github.com/${plan.upstreamRepoPath}/compare/${baseBranch}...${plan.pushOwner}:${plan.branch}?expand=1`;

    if (createPr && upstreamPrUrl) {
      const lines = [`Upstream PR: ${upstreamPrUrl}`];
      if (internalPr) {
        lines.push(`Internal review: ${internalPr.url}`);
      }
      p.note(lines.join('\n'), 'Next Steps');
    } else {
      p.note(
        plan.noPublic
          ? `Your branch is now on upstream!\n\nCreate a pull request:\n  ${prUrl}\n\n(Tip: re-run with --pr to open it automatically.)`
          : `Your branch is now on the public fork!\n\nCreate a pull request to upstream:\n  ${prUrl}\n\n(Tip: re-run with --pr to open it automatically.)`,
        'Next Steps'
      );
    }

    p.outro('✨ Stage complete!');
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Stage failed');
    process.exit(1);
  }
}

import * as p from '@clack/prompts';
import { $ } from 'execa';
import { readVenforkConfigFromRepo, updateVenforkConfig } from '../config.js';
import {
  BranchNotFoundError,
  GitError,
  RemoteNotFoundError,
  StageLeakError,
} from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { confirmOrAutoYes } from '../shared/confirm.js';
import { SYNC_WORKFLOW_PATH, WORKFLOWS_DIR } from '../shared/constants.js';
import { changedFilesInCommit } from '../shared/divergence.js';
import {
  classifyManagedCommit,
  isManagedCommit,
  type ManagedCommitKind,
} from '../shared/managed-commit.js';
import {
  findInternalPr,
  type InternalPrInfo,
  translateInternalBody,
  translateInternalTitle,
} from '../shared/redaction.js';
import { findMirrorRepoPath } from '../shared/repo.js';
import { withDetachedWorktree } from '../shared/worktree.js';
import { parseRepoPath } from '../utils.js';

const CONFIG_BRANCH = 'venfork-config';

async function branchHasManagedCommits(
  branch: string,
  defaultBranch: string,
  cwd: string
): Promise<boolean> {
  const result = await $({
    cwd,
    reject: false,
  })`git rev-list upstream/${defaultBranch}..${branch}`;
  if (result.exitCode !== 0) {
    throw new GitError(
      `Cannot inspect '${branch}' for venfork-managed commits: upstream/${defaultBranch} is not available locally. Run \`git fetch upstream\` and retry.`,
      `git rev-list upstream/${defaultBranch}..${branch}`
    );
  }
  const commits = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const commit of commits) {
    if (await isManagedCommit(commit, cwd)) return true;
  }
  return false;
}

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
  branch: string,
  defaultBranch: string,
  cwd: string
): Promise<void> {
  const mergeListResult = await $({
    cwd,
  })`git rev-list --merges upstream/${defaultBranch}..${branch}`;
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

async function buildPublicStageHeadWithoutWorkflowCommit(
  branch: string,
  defaultBranch: string,
  preserve: string[],
  cwd?: string
): Promise<string> {
  const repoDir = cwd ?? process.cwd();
  // Abort before doing any work if the branch contains a merge commit with
  // manual conflict resolutions outside `.github/workflows/`. `--no-merges`
  // below would silently drop those resolutions, losing work.
  await assertNoEvilMerges(branch, defaultBranch, repoDir);

  // Start a detached worktree at upstream/<defaultBranch> and cherry-pick
  // every branch commit that isn't an internal workflow commit. A
  // content-based filter (rather than `rebase --onto origin`) keeps
  // previously-rewritten managed commits from leaking into the public fork
  // when they're still reachable from older feature branches whose base
  // predates a `venfork sync` rewrite of origin's default branch.
  return withDetachedWorktree(
    repoDir,
    `upstream/${defaultBranch}`,
    'venfork-stage-',
    async (tempDir, hooksDir) => {
      // Skip merge commits: `git cherry-pick` on a merge fails without
      // `-m <parent>`, and merges are commonly used on venfork feature branches
      // to pull `origin/<default>` back in after a sync rewrite. `--no-merges`
      // still walks *both* sides of any merge, so non-merge content from either
      // side is cherry-picked as normal (workflow commits introduced via the
      // merged-in side are then filtered by `isManagedCommit` below).
      // `--topo-order` makes the parent-before-child guarantee explicit (with
      // `--reverse`: ancestors first, descendants last). The default order is
      // pseudo-chronological and can violate topology when commit timestamps
      // are skewed (clock drift, rebases that re-set author dates, etc.),
      // which would surface as cherry-pick conflicts.
      const revListResult = await $({
        cwd: repoDir,
      })`git rev-list --reverse --topo-order --no-merges upstream/${defaultBranch}..${branch}`;
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
      }

      const headResult = await $({ cwd: tempDir })`git rev-parse HEAD`;
      return headResult.stdout.trim();
    }
  );
}

/**
 * Read-only snapshot of the state needed to stage a branch. Computed before
 * any user confirmation so the caller can show a preview, and reused for the
 * actual push (`executeStagingPush`) and any follow-on work (e.g. opening an
 * upstream PR in `shipCommand`).
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
  /** Owner segment of `pushRepoPath` — used as the cross-repo head prefix when the PR head is in a different repo than the base. */
  pushOwner: string;
  /** `'public'` or `'upstream'` — which git remote name to push to. */
  pushRemote: 'public' | 'upstream';
  upstreamUrl: string;
  upstreamRepoPath: string;
  upstreamDefaultBranch: string;
  /** True when the branch carries a venfork-managed commit that must not reach the push target. */
  hasManagedCommits: boolean;
  /** Mirror-only paths from the preserve allowlist; they never exist upstream. */
  preserve: string[];
  /** True when the head and base of the upstream PR live in the same repo (no-public mode). */
  noPublic: boolean;
}

/**
 * Resolves remotes, default branch, and managed-commit presence for a staging push.
 * Pure read; no network writes. Throws `BranchNotFoundError` /
 * `RemoteNotFoundError` so callers can render a single failure path.
 */
async function planStaging(branch: string, cwd: string): Promise<StagingPlan> {
  if (branch.replace(/^(refs\/heads\/|origin\/)/, '') === CONFIG_BRANCH) {
    throw new Error(
      `Refusing to stage '${branch}': it holds venfork's private configuration, not upstream work.`
    );
  }
  const branchCheck = await $({
    cwd,
    reject: false,
  })`git rev-parse --verify ${branch}`;
  if (branchCheck.exitCode !== 0) {
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

  const upstreamDefaultBranch = await getDefaultBranch('upstream');
  const mergeBase = await $({
    cwd,
    reject: false,
  })`git merge-base ${`upstream/${upstreamDefaultBranch}`} ${branch}`;
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
  const hasManagedCommits = await branchHasManagedCommits(
    branch,
    upstreamDefaultBranch,
    cwd
  );

  return {
    branch,
    pushUrl,
    pushRepoPath,
    pushOwner,
    pushRemote,
    upstreamUrl,
    upstreamRepoPath,
    upstreamDefaultBranch,
    hasManagedCommits,
    preserve: [...(config?.preserve ?? []), ...(config?.invalidPreserve ?? [])],
    noPublic,
  };
}

/**
 * Throws {@link StageLeakError} when `head` would add or change the managed
 * sync workflow or a preserved path that upstream's tree does not have.
 * Runs on every stage path before anything is pushed.
 */
async function assertNoMirrorOnlyPaths(
  plan: StagingPlan,
  head: string,
  cwd: string
): Promise<void> {
  const base = `upstream/${plan.upstreamDefaultBranch}`;
  const diff = await $({
    cwd,
    reject: false,
  })`git diff --name-only -z --diff-filter=AMR ${base} ${head}`;
  if (diff.exitCode !== 0) {
    throw new GitError(
      `Cannot compare '${plan.branch}' with ${base}: ${diff.stderr.trim()}`,
      'git diff'
    );
  }
  const leaks: string[] = [];
  for (const file of diff.stdout.split('\0').filter(Boolean)) {
    if (file === SYNC_WORKFLOW_PATH) {
      leaks.push(file);
      continue;
    }
    if (!plan.preserve.includes(file)) continue;
    const upstreamEntry = await $({
      cwd,
      reject: false,
    })`git --literal-pathspecs ls-tree -z ${base} -- ${file}`;
    if (
      !upstreamEntry.stdout.split('\0').some((e) => e.endsWith(`\t${file}`))
    ) {
      leaks.push(file);
    }
  }
  if (leaks.length > 0) {
    throw new StageLeakError(plan.branch, leaks);
  }
}

/**
 * Pushes the branch to the public fork, stripping the internal workflow
 * commit when the branch contains one. Returns the SHA pushed.
 *
 * The caller owns the spinner so consistent UI text appears in every
 * command that stages (`stage`, `ship`).
 */
async function executeStagingPush(
  plan: StagingPlan,
  cwd: string,
  s: ReturnType<typeof p.spinner>
): Promise<string> {
  // In no-public mode the `upstream` remote has its push URL set to DISABLE
  // (so a stray `git push upstream main` from CLI/IDE can't ship the private
  // mirror's history to upstream's default branch). Stage opts in explicitly
  // by pushing to the URL, which bypasses the disabled push URL while
  // leaving the safeguard in place for non-stage workflows.
  const pushDest = plan.noPublic ? plan.pushUrl : plan.pushRemote;
  const target = plan.noPublic ? 'upstream' : 'public fork';

  if (plan.hasManagedCommits) {
    await $({ cwd })`git fetch upstream`;
    await $({ cwd })`git fetch origin`;
    s.start(`Preparing sanitized branch for ${target} staging`);
    const stageHead = await buildPublicStageHeadWithoutWorkflowCommit(
      plan.branch,
      plan.upstreamDefaultBranch,
      plan.preserve,
      cwd
    );
    s.stop('Prepared sanitized branch');
    await assertNoMirrorOnlyPaths(plan, stageHead, cwd);

    s.start(`Pushing sanitized branch to ${target}`);
    // Lease on the tip read via ls-remote: a URL push (no-public mode) has no
    // remote-tracking ref, and a public tracking ref may be stale or absent.
    const ls = await $({
      cwd,
      reject: false,
    })`git ls-remote --exit-code ${pushDest} refs/heads/${plan.branch}`;
    const expectedSha =
      ls.exitCode === 0 ? (ls.stdout.trim().split(/\s+/)[0] ?? '') : '';
    await $({
      cwd,
    })`git push ${pushDest} ${stageHead}:refs/heads/${plan.branch} --force-with-lease=refs/heads/${plan.branch}:${expectedSha}`;
    s.stop('Push successful');
    return stageHead;
  }

  const head = (await $({ cwd })`git rev-parse ${plan.branch}`).stdout.trim();
  await assertNoMirrorOnlyPaths(plan, head, cwd);
  s.start(`Pushing to ${target}`);
  await $({ cwd })`git push ${pushDest} ${plan.branch}`;
  s.stop('Push successful');
  return head;
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
 * Generates a synthetic upstream PR body from the branch's commit log when no
 * internal review PR was found. Lists the subjects of the non-merge,
 * non-managed commits in `upstream/<defaultBranch>..<branch>` (exactly the
 * commits stage publishes), with no SHAs, so nothing points back at the
 * mirror.
 *
 * The body must not reveal the private mirror — upstream only ever sees the
 * commit summary, never that the work was staged from a mirror.
 *
 * Fetches `upstream/<defaultBranch>` first so the log works even when schedule
 * is disabled and the ref may not exist locally yet.
 */
async function buildSyntheticBody(
  branch: string,
  defaultBranch: string,
  cwd: string
): Promise<string> {
  // Ensure the remote-tracking ref exists before running the log.
  await $({ cwd, reject: false })`git fetch upstream ${defaultBranch}`;
  const log = await $({
    cwd,
    reject: false,
  })`git log --no-merges --format=%H%x00%s upstream/${defaultBranch}..${branch}`;
  if (log.exitCode !== 0) {
    return 'No description provided.';
  }
  const subjects: string[] = [];
  for (const line of log.stdout.split('\n')) {
    const [sha, subject] = line.split('\0');
    if (!sha || subject === undefined) continue;
    if (await isManagedCommit(sha, cwd)) continue;
    subjects.push(`- ${subject}`);
  }
  if (subjects.length === 0) {
    return 'No description provided.';
  }
  return `Commits in this branch:\n\n${subjects.join('\n')}`;
}

/**
 * Build the body and title for the upstream PR. Falls back to a generated
 * commit-summary body when there's no internal PR to translate.
 */
async function buildUpstreamPrPayload(
  branch: string,
  internal: InternalPrInfo | null,
  override: { title?: string; body?: string },
  context: { defaultBranch: string; cwd: string }
): Promise<{ title: string; body: string }> {
  if (internal) {
    return {
      title: translateInternalTitle(override.title ?? internal.title),
      body: override.body ?? translateInternalBody(internal.body),
    };
  }
  return {
    title: translateInternalTitle(override.title ?? branch),
    body:
      override.body ??
      (await buildSyntheticBody(branch, context.defaultBranch, context.cwd)),
  };
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
      'Usage: venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>]. Run `venfork help` for the full list of supported options, including `--internal-pr <n>` and `--no-update-existing`.'
    );
    process.exit(1);
  }

  const createPr = Boolean(options.createPr || options.draft);

  const s = p.spinner();
  const repoDir = process.cwd();

  try {
    s.start('Verifying branch exists');
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
      const payload = await buildUpstreamPrPayload(
        plan.branch,
        internalPr,
        { title: options.title },
        { defaultBranch: plan.upstreamDefaultBranch, cwd: repoDir }
      );
      prTitle = payload.title;
      translatedBody = payload.body;
      s.stop(
        internalPr
          ? `Internal PR found: ${internalPr.url}`
          : 'No internal PR found — using synthetic body'
      );
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

    const stagedHead = await executeStagingPush(plan, repoDir, s);

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

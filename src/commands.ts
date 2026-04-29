import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  createConfigBranch,
  fetchVenforkConfig,
  normalizePreservePath,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfig,
} from './config.js';
import {
  AuthenticationError,
  BranchNotFoundError,
  NotInRepositoryError,
  RemoteNotFoundError,
} from './errors.js';
import {
  checkGhAuth,
  getCurrentBranch,
  getDefaultBranch,
  getGitHubUsername,
  getRemotes,
  ghRepoExists,
  ghRepoIsForkOf,
  hasRemote,
  isGitRepository,
} from './git.js';
import {
  normalizeGitHubRepoInput,
  parseOwner,
  parseRepoName,
  parseRepoPath,
} from './utils.js';
import { generateSyncWorkflow, getSyncWorkflowPath } from './workflow.js';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * `p.confirm` wrapper that can return `true` immediately when
 * `VENFORK_NONINTERACTIVE=1` is set in the environment, but only for
 * callers that explicitly opt into that behavior by passing
 * `allowNonInteractive: true`. This lets scripts and tests bypass intended
 * interactive confirms without turning every prompt into an implicit "yes"
 * in CI/non-interactive environments.
 */
async function confirmOrAutoYes(opts: {
  message: string;
  initialValue?: boolean;
  allowNonInteractive?: boolean;
}): Promise<boolean | symbol> {
  if (
    opts.allowNonInteractive === true &&
    process.env.VENFORK_NONINTERACTIVE === '1'
  ) {
    return true;
  }
  return p.confirm(opts);
}

const SYNC_WORKFLOW_PATH = getSyncWorkflowPath();
const WORKFLOW_COMMIT_MESSAGE =
  'chore: add/update scheduled sync workflow (venfork)';
const WORKFLOWS_DIR = '.github/workflows';
const VENFORK_BOT_NAME = 'venfork-bot';
const VENFORK_BOT_EMAIL = 'venfork-bot@users.noreply.github.com';

function normalizeWorkflowList(entries: string[]): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => path.basename(entry.trim()))
        .filter((entry) => entry.length > 0)
        .sort()
    )
  );
}

async function commitSubject(
  ref: string,
  cwd?: string
): Promise<string | null> {
  const cwdOpt = cwd ? { cwd } : {};
  const result = await $({
    ...cwdOpt,
    reject: false,
  })`git log -1 --format=%s ${ref}`;
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function commitTouchesWorkflowPath(
  ref: string,
  cwd?: string
): Promise<boolean> {
  const cwdOpt = cwd ? { cwd } : {};
  const filesResult = await $({
    ...cwdOpt,
    reject: false,
  })`git show --name-only --pretty=format: ${ref}`;
  if (filesResult.exitCode !== 0) {
    return false;
  }
  const changedFiles = filesResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!changedFiles.length) {
    return false;
  }
  // A commit is the venfork-managed "+1" only when it (a) touches the managed
  // workflow file and (b) doesn't reach outside `.github/workflows/`. Without
  // (a), legitimate user commits to other workflows (e.g. ci.yml) would be
  // silently dropped during stage. Without (b), arbitrary user commits could
  // be misclassified as managed.
  const allUnderWorkflows = changedFiles.every((filePath) =>
    filePath.startsWith(`${WORKFLOWS_DIR}/`)
  );
  const touchesManagedWorkflow = changedFiles.includes(SYNC_WORKFLOW_PATH);
  return allUnderWorkflows && touchesManagedWorkflow;
}

/**
 * Internal workflow commit marker used by the mirror "+1 commit" model.
 *
 * We identify this commit by its deterministic message and also accept commits
 * that touch the managed `venfork-sync.yml` plus only sibling files under
 * `.github/workflows/` — so historical rollouts that bundled extra workflow
 * files alongside the managed one are still classified as managed, while
 * user-authored commits to *other* workflow files (e.g. ci.yml) are preserved.
 */
async function isWorkflowCommit(ref: string, cwd?: string): Promise<boolean> {
  const subject = await commitSubject(ref, cwd);
  if (subject === WORKFLOW_COMMIT_MESSAGE) {
    return true;
  }
  return commitTouchesWorkflowPath(ref, cwd);
}

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*') {
    return true;
  }

  const isValidNumber = (value: string): boolean => {
    if (!/^\d+$/.test(value)) {
      return false;
    }
    const parsed = Number.parseInt(value, 10);
    return parsed >= min && parsed <= max;
  };

  const isValidRange = (value: string): boolean => {
    const [start, end] = value.split('-');
    if (!start || !end || !isValidNumber(start) || !isValidNumber(end)) {
      return false;
    }
    return Number.parseInt(start, 10) <= Number.parseInt(end, 10);
  };

  const stepParts = field.split('/');
  if (stepParts.length > 2) {
    return false;
  }
  if (stepParts.length === 2) {
    const [base, step] = stepParts;
    if (
      !base ||
      !step ||
      !isValidNumber(step) ||
      Number.parseInt(step, 10) <= 0
    ) {
      return false;
    }
    if (base === '*') {
      return true;
    }
    if (base.includes(',')) {
      return false;
    }
    return base.includes('-') ? isValidRange(base) : isValidNumber(base);
  }

  if (field.includes(',')) {
    return field
      .split(',')
      .every((part) =>
        part.includes('-') ? isValidRange(part) : isValidNumber(part)
      );
  }
  if (field.includes('-')) {
    return isValidRange(field);
  }
  return isValidNumber(field);
}

function isValidCronExpression(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }, // day of week
  ];

  return parts.every((part, index) => {
    const range = ranges[index];
    return isValidCronField(part, range.min, range.max);
  });
}

async function isScheduleEnabled(cwd?: string): Promise<boolean> {
  const repoDir = cwd ?? process.cwd();
  const config = await readVenforkConfigFromRepo(repoDir);
  return Boolean(config?.schedule?.enabled);
}

async function listWorkflowFiles(cwd: string): Promise<string[]> {
  const result = await $({
    cwd,
    reject: false,
  })`git ls-tree -r --name-only HEAD ${WORKFLOWS_DIR}`;
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function remoteBranchExists(
  remote: string,
  branch: string
): Promise<boolean> {
  const result = await $({
    reject: false,
  })`git ls-remote --exit-code --heads ${remote} ${branch}`;
  return result.exitCode === 0;
}

/**
 * Re-stamp `origin/<defaultBranch>` as `upstream/<defaultBranch>` plus one
 * deterministic "+1 commit" containing the managed sync workflow (when
 * scheduled) and any preserved mirror-only files. Force-pushes the result.
 *
 * `previousMirrorTip` is the commit-ish to read preserve sources from
 * (typically captured from `git rev-parse origin/<defaultBranch>` *before*
 * sync's force-push runs). Pass an empty string when no previous tip exists
 * (first sync); preserve must be empty in that case.
 */
async function applyMirrorPlusOneCommit(args: {
  defaultBranch: string;
  schedule: { cron: string; mode: 'standard' | 'no-public' } | null;
  enabledWorkflows: string[];
  disabledWorkflows: string[];
  preserve: string[];
  previousMirrorTip: string;
  cwd?: string;
}): Promise<void> {
  const {
    defaultBranch,
    schedule,
    enabledWorkflows,
    disabledWorkflows,
    preserve,
    previousMirrorTip,
    cwd,
  } = args;
  const repoDir = cwd ?? process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-sync-'));
  const allowlist = normalizeWorkflowList(enabledWorkflows);
  const blocklist = normalizeWorkflowList(disabledWorkflows);

  try {
    // Re-stamp from upstream so the private mirror default branch is always
    // `upstream + exactly one deterministic internal workflow commit`.
    await $({
      cwd: repoDir,
    })`git worktree add --detach ${tempDir} upstream/${defaultBranch}`;

    if (schedule) {
      await mkdir(path.join(tempDir, '.github', 'workflows'), {
        recursive: true,
      });
      await writeFile(
        path.join(tempDir, SYNC_WORKFLOW_PATH),
        generateSyncWorkflow(schedule.cron, schedule.mode)
      );
      await $({ cwd: tempDir })`git add ${SYNC_WORKFLOW_PATH}`;

      // Filter upstream workflow files as part of the managed "+1" commit.
      // Precedence: enabledWorkflows allowlist > disabledWorkflows blocklist.
      if (allowlist.length > 0 || blocklist.length > 0) {
        const workflowFiles = await listWorkflowFiles(tempDir);
        for (const workflowFile of workflowFiles) {
          if (workflowFile === SYNC_WORKFLOW_PATH) {
            continue;
          }
          const base = path.basename(workflowFile);
          const shouldKeep =
            allowlist.length > 0
              ? allowlist.includes(base)
              : !blocklist.includes(base);
          if (!shouldKeep) {
            await $({
              cwd: tempDir,
              reject: false,
            })`git rm --quiet --ignore-unmatch ${workflowFile}`;
          }
        }
      }
    }

    if (preserve.length > 0) {
      if (!previousMirrorTip) {
        throw new Error(
          `Cannot preserve files: no previous origin/${defaultBranch} tip to read from.\n` +
            'Run `venfork sync` once to populate the mirror, then commit your preserved files and re-run sync.'
        );
      }
      for (const preservePath of preserve) {
        const upstreamHasIt = await pathExists(
          path.join(tempDir, preservePath)
        );
        if (upstreamHasIt) {
          p.log.warn(
            `preserved file '${preservePath}' now exists upstream — using upstream version`
          );
          continue;
        }
        const showResult = await $({
          cwd: repoDir,
          reject: false,
          encoding: 'buffer',
          stripFinalNewline: false,
        })`git show ${previousMirrorTip}:${preservePath}`;
        if (showResult.exitCode !== 0) {
          throw new Error(
            `Preserved file '${preservePath}' not found on origin/${defaultBranch}.\n` +
              'Either commit it to the mirror first, or remove the entry with:\n' +
              `  venfork preserve remove ${preservePath}`
          );
        }
        // Preserve the executable bit by reading the tree entry's mode.
        // `git show <ref>:<path>` only emits content; mode lives on the tree.
        // Symlinks (120000) and submodules (160000) are out of scope — those
        // would need plumbing-level handling. Plain files and `+x` files cover
        // the realistic mirror-only cases (caller workflows, release scripts).
        const lsTreeResult = await $({
          cwd: repoDir,
          reject: false,
        })`git ls-tree ${previousMirrorTip} -- ${preservePath}`;
        const treeMode = lsTreeResult.stdout.match(/^(\d+) /)?.[1];
        const targetPath = path.join(tempDir, preservePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, showResult.stdout);
        if (treeMode === '100755') {
          await chmod(targetPath, 0o755);
        }
        await $({ cwd: tempDir })`git add ${preservePath}`;
      }
    }

    await $({
      cwd: tempDir,
    })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit --allow-empty -m ${WORKFLOW_COMMIT_MESSAGE}`;

    await $({
      cwd: tempDir,
    })`git push origin HEAD:${defaultBranch} --force-with-lease`;
  } finally {
    await $({
      cwd: repoDir,
      reject: false,
    })`git worktree remove --force ${tempDir}`;
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Lists the file paths changed by a single commit. Returns an empty array on
 * git error or for empty commits. Shared by `isPreservedCommit` and the
 * divergence-check file collection — both want the same name-only output.
 *
 * Uses `diff-tree -m --first-parent` instead of `git show` so merge commits
 * are diffed against their *first parent* (everything the merge brought in
 * from the side branch), not the default combined-diff (`--cc`) which only
 * surfaces conflict-resolution files. Without this, a clean merge that
 * touches a preserved file would show zero changed files — which would
 * make `isPreservedCommit` return false and abort sync on a benign merge.
 */
async function changedFilesInCommit(
  ref: string,
  cwd?: string
): Promise<string[]> {
  const cwdOpt = cwd ? { cwd } : {};
  const result = await $({
    ...cwdOpt,
    reject: false,
  })`git diff-tree -r --no-commit-id --name-only -m --first-parent ${ref}`;
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Returns true when every file changed by `ref` is in the preserve allowlist.
 * Used by sync's divergence check to allow user-authored mirror-only commits
 * (e.g. a caller workflow) ahead of upstream — as long as every changed file
 * is something the user has explicitly opted into preserving.
 */
async function isPreservedCommit(
  ref: string,
  preserveList: string[],
  cwd?: string
): Promise<boolean> {
  if (preserveList.length === 0) return false;
  const changedFiles = await changedFilesInCommit(ref, cwd);
  if (changedFiles.length === 0) return false;
  const allowed = new Set(preserveList);
  return changedFiles.every((file) => allowed.has(file));
}

async function updateWorkflowOnOriginDefault(
  defaultBranch: string,
  workflowContent: string | null,
  cwd?: string
): Promise<boolean> {
  const repoDir = cwd ?? process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-workflow-'));

  try {
    await $({
      cwd: repoDir,
    })`git worktree add --detach ${tempDir} origin/${defaultBranch}`;

    if (workflowContent === null) {
      await $({
        cwd: tempDir,
        reject: false,
      })`git rm --quiet --ignore-unmatch ${SYNC_WORKFLOW_PATH}`;
    } else {
      await mkdir(path.join(tempDir, '.github', 'workflows'), {
        recursive: true,
      });
      await writeFile(path.join(tempDir, SYNC_WORKFLOW_PATH), workflowContent);
      await $({ cwd: tempDir })`git add ${SYNC_WORKFLOW_PATH}`;
    }

    const stagedDiff = await $({
      cwd: tempDir,
      reject: false,
    })`git diff --cached --quiet`;
    if (stagedDiff.exitCode === 0) {
      return false;
    }

    await $({
      cwd: tempDir,
    })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit -m ${WORKFLOW_COMMIT_MESSAGE}`;
    await $({
      cwd: tempDir,
    })`git push origin HEAD:${defaultBranch} --force-with-lease`;
    return true;
  } finally {
    await $({
      cwd: repoDir,
      reject: false,
    })`git worktree remove --force ${tempDir}`;
    await rm(tempDir, { recursive: true, force: true });
  }
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
  cwd?: string
): Promise<string> {
  const repoDir = cwd ?? process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-stage-'));
  try {
    // Start a detached worktree at upstream/<defaultBranch> and cherry-pick
    // every branch commit that isn't an internal workflow commit. A
    // content-based filter (rather than `rebase --onto origin`) keeps
    // previously-rewritten managed commits from leaking into the public fork
    // when they're still reachable from older feature branches whose base
    // predates a `venfork sync` rewrite of origin's default branch.
    // Abort before doing any work if the branch contains a merge commit with
    // manual conflict resolutions outside `.github/workflows/`. `--no-merges`
    // below would silently drop those resolutions, losing work.
    await assertNoEvilMerges(branch, defaultBranch, repoDir);

    await $({
      cwd: repoDir,
    })`git worktree add --detach ${tempDir} upstream/${defaultBranch}`;

    // Skip merge commits: `git cherry-pick` on a merge fails without
    // `-m <parent>`, and merges are commonly used on venfork feature branches
    // to pull `origin/<default>` back in after a sync rewrite. `--no-merges`
    // still walks *both* sides of any merge, so non-merge content from either
    // side is cherry-picked as normal (workflow commits introduced via the
    // merged-in side are then filtered by `isWorkflowCommit` below).
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
    for (const commit of branchCommits) {
      if (!(await isWorkflowCommit(commit, repoDir))) {
        commitsToPick.push(commit);
      }
    }

    for (const commit of commitsToPick) {
      const pickResult = await $({
        cwd: tempDir,
        reject: false,
      })`git cherry-pick --allow-empty ${commit}`;
      if (pickResult.exitCode !== 0) {
        await $({
          cwd: tempDir,
          reject: false,
        })`git cherry-pick --abort`;
        throw new Error(
          `Failed to stage '${branch}' because cherry-picking ${commit} onto upstream/${defaultBranch} caused conflicts. Rebase '${branch}' on upstream/${defaultBranch} and retry.`
        );
      }
    }

    const headResult = await $({ cwd: tempDir })`git rev-parse HEAD`;
    return headResult.stdout.trim();
  } finally {
    await $({
      cwd: repoDir,
      reject: false,
    })`git worktree remove --force ${tempDir}`;
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function ensureVenforkRemotes(
  cwd: string,
  publicUrl: string | undefined,
  upstreamUrl: string
): Promise<void> {
  const setOrAdd = async (name: string, fetchUrl: string) => {
    const cur = await $({ cwd, reject: false })`git remote get-url ${name}`;
    if (cur.exitCode === 0) {
      const existing = cur.stdout.trim();
      if (parseRepoPath(existing) !== parseRepoPath(fetchUrl)) {
        await $({ cwd })`git remote set-url ${name} ${fetchUrl}`;
      }
    } else {
      await $({ cwd })`git remote add ${name} ${fetchUrl}`;
    }
  };

  if (publicUrl) {
    await setOrAdd('public', publicUrl);
  } else {
    // No-public mode: remove a stale `public` remote left over from a prior
    // standard-mode setup so the local layout matches the recorded config.
    const existing = await $({
      cwd,
      reject: false,
    })`git remote get-url public`;
    if (existing.exitCode === 0) {
      await $({ cwd })`git remote remove public`;
    }
  }
  await setOrAdd('upstream', upstreamUrl);
  await $({ cwd })`git remote set-url --push upstream DISABLE`;
}

/**
 * Setup command: Create private mirror and public fork
 *
 * @param publicForkRepoName - Optional GitHub repo name for the public fork under `owner` (see `gh repo fork --fork-name`). Defaults to the upstream repo basename. Use when the fork must differ (e.g. same org as upstream).
 * @param options.noPublic - Skip the public-fork hop entirely. Only `origin` (private mirror) and `upstream` are configured; `stage` later pushes branches directly to `upstream`. Mutually exclusive with `publicForkRepoName`.
 */
export async function setupCommand(
  upstreamUrl?: string,
  privateMirrorName?: string,
  organization?: string,
  publicForkRepoName?: string,
  options: { noPublic?: boolean } = {}
): Promise<void> {
  const noPublic = options.noPublic === true;
  if (noPublic && publicForkRepoName?.trim()) {
    throw new Error(
      '--no-public cannot be combined with a public fork name: --no-public skips creating a public fork.'
    );
  }
  p.intro('🔧 Venfork Setup');

  // Check GitHub CLI authentication
  const isAuthenticated = await checkGhAuth();
  if (!isAuthenticated) {
    throw new AuthenticationError();
  }

  // Get configuration from user or use provided arguments
  let finalUpstreamUrl = upstreamUrl;
  let finalPrivateMirrorName = privateMirrorName;

  const validateUpstreamInput = (value: string): string | undefined => {
    if (!value?.trim()) {
      return 'GitHub repository is required';
    }
    const canonical = normalizeGitHubRepoInput(value);
    const repoPath = parseRepoPath(canonical);
    if (!repoPath || !/^[^/]+\/[^/]+$/.test(repoPath)) {
      return 'Use a GitHub clone URL or owner/repo (e.g. invertase/react-native-firebase)';
    }
    return undefined;
  };

  // Prompt for upstream URL only if not provided
  if (!finalUpstreamUrl) {
    const response = await p.text({
      message: 'Upstream repository URL or owner/repo?',
      placeholder: 'invertase/react-native-firebase',
      validate: validateUpstreamInput,
    });

    if (p.isCancel(response)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    finalUpstreamUrl = normalizeGitHubRepoInput(response as string);
  } else {
    finalUpstreamUrl = normalizeGitHubRepoInput(finalUpstreamUrl);
  }

  if (!parseRepoPath(finalUpstreamUrl)) {
    p.log.error(
      'Invalid upstream repository. Pass a GitHub URL or owner/repo.'
    );
    p.outro('❌ Setup failed');
    process.exit(1);
  }

  // Prompt for private mirror name only if not provided
  if (!finalPrivateMirrorName) {
    const defaultName = `${parseRepoName(finalUpstreamUrl)}-private`;
    const response = await p.text({
      message: 'Private mirror repo name?',
      placeholder: defaultName,
      defaultValue: defaultName,
      validate: (value) => {
        if (!value) return 'Private mirror repo name is required';
        if (!/^[a-zA-Z0-9-_]+$/.test(value))
          return 'Name can only contain letters, numbers, hyphens, and underscores';
      },
    });

    if (p.isCancel(response)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    finalPrivateMirrorName = response as string;
  }

  const config = {
    upstreamUrl: finalUpstreamUrl,
    privateMirrorName: finalPrivateMirrorName,
  };

  const upstreamRepoBaseName = parseRepoName(config.upstreamUrl);
  const forkNameFromCli = publicForkRepoName?.trim();
  if (forkNameFromCli && !/^[a-zA-Z0-9._-]+$/.test(forkNameFromCli)) {
    p.log.error(
      'Invalid --fork-name: use only letters, numbers, periods, hyphens, and underscores.'
    );
    p.outro('❌ Setup failed');
    process.exit(1);
  }
  const resolvedPublicForkName = forkNameFromCli || upstreamRepoBaseName;
  const useForkNameFlag = resolvedPublicForkName !== upstreamRepoBaseName;

  const s = p.spinner();
  const username = await getGitHubUsername();

  // If organization is the user's personal account, treat it as no organization
  if (organization && organization === username) {
    organization = undefined;
  }

  // If no organization is specified, confirm before using personal account
  if (!organization) {
    p.log.warn('⚠️  No organization specified');
    p.log.info(
      `Repos will be created under your personal account (username: ${username})`
    );

    const confirmed = await p.confirm({
      message: 'Continue with personal account?',
      initialValue: false,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.outro('❌ Setup cancelled');
      process.exit(0);
    }
  }

  // Determine the account owner (org or user)
  const owner = organization || username;

  // Generate unique temp directory in OS temp folder
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-${uniqueId}`);

  // Track cleanup state to ensure it only runs once
  let cleanupDone = false;
  const cleanup = async () => {
    if (!cleanupDone) {
      cleanupDone = true;
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors - temp dir may not exist or already cleaned
      }
    }
  };

  // Handle Ctrl+C and kill signals
  const signalHandler = async () => {
    s.stop('Setup interrupted');
    await cleanup();
    process.exit(130); // Standard exit code for SIGINT
  };

  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  try {
    const upstreamRepoPath = parseRepoPath(config.upstreamUrl);
    const publicForkName = resolvedPublicForkName;
    const publicForkFullName = `${owner}/${publicForkName}`;
    const privateMirrorRepoName = organization
      ? `${organization}/${config.privateMirrorName}`
      : config.privateMirrorName;
    const privateMirrorGhPath = organization
      ? `${organization}/${config.privateMirrorName}`
      : `${owner}/${config.privateMirrorName}`;
    const privateCloneUrl = `git@github.com:${owner}/${config.privateMirrorName}.git`;
    const publicForkUrl = noPublic
      ? undefined
      : `git@github.com:${owner}/${publicForkName}.git`;

    // Step 1: Create public fork (or accept an existing fork under this owner) — skipped in --no-public mode
    let forkPreexisted = false;
    if (!noPublic) {
      s.start('Creating public fork of upstream repository');
      const forkResult = organization
        ? useForkNameFlag
          ? await $({
              reject: false,
            })`gh repo fork ${upstreamRepoPath} --clone=false --org ${organization} --fork-name ${publicForkName}`
          : await $({
              reject: false,
            })`gh repo fork ${upstreamRepoPath} --clone=false --org ${organization}`
        : useForkNameFlag
          ? await $({
              reject: false,
            })`gh repo fork ${upstreamRepoPath} --clone=false --fork-name ${publicForkName}`
          : await $({
              reject: false,
            })`gh repo fork ${upstreamRepoPath} --clone=false`;

      if (forkResult.exitCode !== 0) {
        if (publicForkFullName === upstreamRepoPath && !useForkNameFlag) {
          throw new Error(
            `The upstream repo is already under ${owner}. Use --fork-name to give the public fork a different name, or pass --no-public to skip the public fork hop entirely.`
          );
        }
        const exists = await ghRepoExists(publicForkFullName);
        if (!exists) {
          throw new Error(
            forkResult.stderr.trim() ||
              forkResult.stdout.trim() ||
              'gh repo fork failed'
          );
        }
        const isExpectedFork = await ghRepoIsForkOf(
          publicForkFullName,
          upstreamRepoPath
        );
        if (!isExpectedFork) {
          throw new Error(
            `Cannot reuse ${publicForkFullName} as public fork: it is not a fork of ${upstreamRepoPath}. Choose a different --fork-name.`
          );
        }
        forkPreexisted = true;
        s.stop('Public fork already exists');
      } else {
        s.stop('Public fork created');
      }
    }

    // Step 2: Create private mirror (or accept an existing repo)
    s.start('Creating private mirror repository');
    const createResult = await $({
      reject: false,
    })`gh repo create ${privateMirrorRepoName} --private --clone=false`;

    let mirrorPreexisted = false;
    if (createResult.exitCode !== 0) {
      const exists = await ghRepoExists(privateMirrorGhPath);
      if (!exists) {
        throw new Error(
          createResult.stderr.trim() ||
            createResult.stdout.trim() ||
            'gh repo create failed'
        );
      }
      mirrorPreexisted = true;
      s.stop('Private mirror already exists');
    } else {
      s.stop('Private mirror repository created');
    }

    const needsInitialPopulate = !mirrorPreexisted;

    // Steps 3–5: Seed a brand-new private mirror from upstream
    if (needsInitialPopulate) {
      s.start('Cloning upstream repository');
      await $`gh repo clone ${upstreamRepoPath} ${tempDir}`;
      s.stop('Upstream cloned');

      s.start('Detecting default branch');
      const result = await $({
        cwd: tempDir,
        reject: false,
      })`git symbolic-ref refs/remotes/origin/HEAD`;

      let defaultBranch = 'main';
      if (result.exitCode === 0) {
        const match = result.stdout
          .trim()
          .match(/refs\/remotes\/origin\/(.+)$/);
        if (match?.[1]) {
          defaultBranch = match[1];
        }
      }
      s.stop(`Default branch: ${defaultBranch}`);

      s.start(`Pushing ${defaultBranch} to private mirror repository`);
      await $({
        cwd: tempDir,
      })`git push ${privateCloneUrl} ${defaultBranch}:${defaultBranch}`;
      s.stop('Pushed to private mirror repository');
    }

    // Step 6: Local clone of the private mirror
    const repoDir = config.privateMirrorName;
    s.start('Preparing local private mirror clone');
    if (await pathExists(repoDir)) {
      const inGit = await $({
        cwd: repoDir,
        reject: false,
      })`git rev-parse --git-dir`;
      if (inGit.exitCode !== 0) {
        throw new Error(
          `Directory '${repoDir}' already exists and is not a git repository`
        );
      }
      const originResult = await $({
        cwd: repoDir,
        reject: false,
      })`git remote get-url origin`;
      if (originResult.exitCode !== 0) {
        throw new Error(
          `Directory '${repoDir}' exists but has no origin remote configured`
        );
      }
      const existingPath = parseRepoPath(originResult.stdout.trim());
      const expectedPath = parseRepoPath(privateCloneUrl);
      if (existingPath !== expectedPath) {
        throw new Error(
          `Directory '${repoDir}' exists with origin ${originResult.stdout.trim()}, expected ${privateCloneUrl}`
        );
      }
      s.stop('Using existing local clone');
    } else {
      await $`gh repo clone ${privateMirrorGhPath} ${repoDir}`;
      s.stop('Private mirror repository cloned');
    }

    // Step 7: Configure remotes
    s.start('Configuring git remotes');
    await ensureVenforkRemotes(repoDir, publicForkUrl, config.upstreamUrl);
    s.stop('Git remotes configured');

    // Step 8: Venfork config branch
    s.start('Creating venfork configuration');
    await createConfigBranch(
      repoDir,
      noPublic ? null : (publicForkUrl ?? null),
      config.upstreamUrl,
      noPublic ? 'no-public' : 'standard'
    );
    s.stop('Venfork configuration created');

    const recovered = forkPreexisted || mirrorPreexisted;
    if (recovered) {
      p.log.info(
        'Repos already existed on GitHub; syncing default branch from upstream into this clone'
      );
      const repoAbs = path.resolve(repoDir);
      await syncCommand(undefined, { cwd: repoAbs, quiet: true });
    }

    // Show remote configuration
    const remotesOutput = await $({ cwd: repoDir })`git remote -v`;
    const remotesText = remotesOutput.stdout;

    p.note(remotesText.trim(), 'Git Remote Configuration');

    p.note(
      noPublic
        ? `Private Mirror: https://github.com/${privateMirrorGhPath} (for internal work)
Upstream: ${config.upstreamUrl} (read-only; stage pushes branches here directly)`
        : `Private Mirror: https://github.com/${privateMirrorGhPath} (for internal work)
Public Fork: https://github.com/${publicForkFullName} (for staging to upstream)
Upstream: ${config.upstreamUrl} (read-only)`,
      recovered ? 'Repositories (existing)' : 'Repositories Created'
    );

    p.outro(
      `✨ Setup complete!\n\nNext steps:
  cd ${repoDir}
  git checkout -b feature-branch
  # Do your work, push to origin (private)
  # When ready to share: venfork stage feature-branch`
    );
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Setup failed');
    await cleanup();
    process.exit(1);
  } finally {
    // Ensure cleanup and remove signal handlers
    await cleanup();
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
  }
}

/**
 * Clone command: Clone vendor repository and configure all remotes
 */
export async function cloneCommand(
  vendorRepoUrl?: string,
  options: { noPublic?: boolean; upstreamUrl?: string } = {}
): Promise<void> {
  p.intro('🔧 Venfork Clone');

  // Validate vendor repo URL provided
  if (!vendorRepoUrl?.trim()) {
    p.log.error('Vendor repository URL is required');
    p.outro('❌ Clone failed');
    process.exit(1);
  }

  const vendorCloneUrl = normalizeGitHubRepoInput(vendorRepoUrl);
  if (!parseRepoPath(vendorCloneUrl)) {
    p.log.error(
      'Invalid vendor repository. Use a GitHub URL or owner/repo (e.g. invertase/project-private).'
    );
    p.outro('❌ Clone failed');
    process.exit(1);
  }

  // Step 1: Check GitHub CLI authentication
  const isAuthenticated = await checkGhAuth();
  if (!isAuthenticated) {
    throw new AuthenticationError();
  }

  const s = p.spinner();

  try {
    // Parse vendor repo details
    const vendorRepoName = parseRepoName(vendorCloneUrl);
    const owner = parseOwner(vendorCloneUrl);

    if (!owner || !vendorRepoName) {
      throw new Error('Invalid vendor repository URL');
    }

    // Check if directory already exists
    try {
      await $`test -d ${vendorRepoName}`;
      p.log.error(`Directory '${vendorRepoName}' already exists.`);
      p.outro('❌ Clone failed');
      process.exit(1);
    } catch {
      // Directory doesn't exist, good to proceed
    }

    // Step 2: Clone vendor repository (gh respects git_protocol and accepts owner/repo)
    const vendorGhPath = parseRepoPath(vendorCloneUrl);
    s.start('Cloning vendor repository');
    await $`gh repo clone ${vendorGhPath} ${vendorRepoName}`;
    s.stop('Vendor repository cloned');

    // Step 3: Try to fetch venfork config
    s.start('Fetching venfork configuration');
    const config = await fetchVenforkConfig(vendorCloneUrl);

    let publicForkUrl: string | undefined;
    let upstreamUrl: string;
    let noPublic: boolean;

    if (config) {
      // Config branch is authoritative when present. Reject inconsistent
      // user flags up front so the user notices the contradiction.
      const configMode: 'standard' | 'no-public' =
        config.mode === 'no-public' ? 'no-public' : 'standard';
      if (options.noPublic && configMode === 'standard') {
        throw new Error(
          'Refusing to clone with --no-public: the venfork-config branch records mode=standard. To convert an existing setup, re-run `venfork setup` instead.'
        );
      }
      if (options.upstreamUrl && options.upstreamUrl !== config.upstreamUrl) {
        throw new Error(
          `Refusing to override venfork-config: --upstream='${options.upstreamUrl}' but config records upstreamUrl='${config.upstreamUrl}'.`
        );
      }

      noPublic = configMode === 'no-public';
      publicForkUrl = config.publicForkUrl;
      upstreamUrl = config.upstreamUrl;

      const upstreamRepoPath = parseRepoPath(upstreamUrl);

      s.stop('Configuration found');
      p.log.success(`✓ Using config from venfork-config branch`);
      if (noPublic) {
        p.note(
          `Mode: no-public\nUpstream: ${upstreamRepoPath}`,
          'Configuration'
        );
      } else {
        const publicRepoPath = publicForkUrl
          ? parseRepoPath(publicForkUrl)
          : '(missing)';
        p.note(
          `Public fork: ${publicRepoPath}\nUpstream: ${upstreamRepoPath}`,
          'Configuration'
        );
      }
    } else {
      // No config branch (legacy mirror). Fall back to auto-detection,
      // honoring `--no-public` / `--upstream` flags as the explicit override.
      noPublic = options.noPublic === true;
      s.stop(
        noPublic
          ? 'No configuration found, using --no-public layout'
          : 'No configuration found, using auto-detection'
      );

      if (noPublic) {
        // No public fork to look up; only resolve upstream.
        publicForkUrl = undefined;
        if (options.upstreamUrl) {
          upstreamUrl = options.upstreamUrl;
        } else {
          const response = await p.text({
            message:
              'Upstream URL? (no venfork-config branch was found, so it cannot be auto-detected)',
            placeholder: 'git@github.com:owner/repo.git',
          });
          if (p.isCancel(response) || !(response as string).trim()) {
            p.outro('❌ Clone cancelled');
            process.exit(1);
          }
          upstreamUrl = (response as string).trim();
        }
      } else {
        // Step 3a: Auto-detect public fork
        s.start('Detecting public fork');

        // Try to strip -private suffix
        let publicRepoName = vendorRepoName;
        if (vendorRepoName.endsWith('-private')) {
          publicRepoName = vendorRepoName.replace(/-private$/, '');
        }

        // Verify public fork exists
        try {
          await $`gh repo view ${owner}/${publicRepoName}`;
          publicForkUrl = `git@github.com:${owner}/${publicRepoName}.git`;
          s.stop(`Found public fork: ${owner}/${publicRepoName}`);
        } catch {
          s.stop('Public fork not found');

          p.log.warn('⚠️  Could not auto-detect public fork.');
          p.note(
            `Tried: ${owner}/${publicRepoName}\n\nTip: if this mirror has no public fork, re-run with --no-public --upstream <url>.`,
            'Detection Failed'
          );

          const response = await p.text({
            message: 'Please provide the public fork URL:',
            placeholder: 'git@github.com:owner/repo.git',
          });

          if (p.isCancel(response)) {
            p.outro('❌ Clone cancelled');
            process.exit(1);
          }

          publicForkUrl = response as string;
          publicRepoName = parseRepoName(publicForkUrl);
        }

        // Step 3b: Auto-detect upstream from public fork's parent — or use
        // --upstream if the user supplied it explicitly.
        s.start('Detecting upstream repository');

        if (options.upstreamUrl) {
          upstreamUrl = options.upstreamUrl;
          s.stop(`Using --upstream: ${parseRepoPath(upstreamUrl)}`);
        } else {
          try {
            const result =
              await $`gh repo view ${owner}/${publicRepoName} --json parent --jq '.parent.url'`;
            upstreamUrl = result.stdout.trim();

            if (!upstreamUrl || upstreamUrl === 'null') {
              throw new Error('No parent found');
            }

            const upstreamPath = parseRepoPath(upstreamUrl);
            s.stop(`Found upstream: ${upstreamPath}`);
          } catch {
            s.stop('Upstream not found');

            p.log.warn('⚠️  Public fork has no parent repository.');

            const response = await p.text({
              message: 'Please provide the upstream URL:',
              placeholder: 'git@github.com:original/repo.git',
            });

            if (p.isCancel(response)) {
              p.outro('❌ Clone cancelled');
              process.exit(1);
            }

            upstreamUrl = response as string;
          }
        }
      }
    }

    // Step 4: Configure remotes
    s.start('Configuring git remotes');

    // origin is already configured from clone

    // Add public fork remote (skipped in no-public mode)
    if (!noPublic && publicForkUrl) {
      await $({
        cwd: vendorRepoName,
      })`git remote add public ${publicForkUrl}`;
    }

    // Add upstream remote (with push disabled)
    await $({ cwd: vendorRepoName })`git remote add upstream ${upstreamUrl}`;
    await $({
      cwd: vendorRepoName,
    })`git remote set-url --push upstream DISABLE`;

    s.stop('Git remotes configured');

    // Step 5: Show configuration
    const remotesOutput = await $({ cwd: vendorRepoName })`git remote -v`;
    const remotesText = remotesOutput.stdout;

    p.note(remotesText.trim(), 'Git Remote Configuration');

    // Step 6: Success output
    p.outro(
      `✨ Clone complete!\n\nNext steps:
  cd ${vendorRepoName}
  venfork sync          # Sync with upstream
  git checkout -b feature-branch
  # Do your work...
  venfork stage feature-branch`
    );
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Clone failed');
    process.exit(1);
  }
}

/**
 * Sync command: Update default branches of origin and public to match upstream
 */
/**
 * Returns the upstream PR number for `branch` if it's a pulled-in PR. First
 * checks `venfork-config.pulledPrs` (recorded by `venfork pull-request`),
 * then falls back to the `upstream-pr/<n>` naming convention. Returns null
 * if the branch is not a pulled PR (sync routes to the default flow).
 */
function resolvePulledPr(
  branch: string,
  config: VenforkConfig | null
): { prNumber: number; tracked: boolean } | null {
  const recorded = config?.pulledPrs?.[branch];
  if (recorded?.upstreamPrNumber) {
    return { prNumber: recorded.upstreamPrNumber, tracked: true };
  }
  const conventionMatch = branch.match(/^upstream-pr\/(\d+)$/);
  if (conventionMatch) {
    return { prNumber: Number(conventionMatch[1]), tracked: false };
  }
  return null;
}

async function syncPulledPr(
  branch: string,
  prNumber: number,
  cwd: string,
  s: ReturnType<typeof p.spinner>
): Promise<void> {
  s.start(`Fetching pull/${prNumber}/head from upstream`);
  const fetchResult = await $({
    cwd,
    reject: false,
  })`git fetch upstream pull/${prNumber}/head:${branch}`;
  if (fetchResult.exitCode !== 0) {
    // git fetch refuses to clobber a divergent local branch; force into the
    // local ref since the source of truth for pulled PRs is upstream.
    const forceResult = await $({
      cwd,
      reject: false,
    })`git fetch upstream +pull/${prNumber}/head:${branch}`;
    if (forceResult.exitCode !== 0) {
      throw new Error(
        `git fetch upstream pull/${prNumber}/head failed:\n${(forceResult.stderr || fetchResult.stderr).trim()}`
      );
    }
  }
  const headSha = (await $({ cwd })`git rev-parse ${branch}`).stdout.trim();
  s.stop(`Fetched ${headSha.slice(0, 9)} → ${branch}`);

  s.start(`Pushing ${branch} to origin`);
  const pushResult = await $({
    cwd,
    reject: false,
  })`git push origin ${branch} --force-with-lease`;
  if (pushResult.exitCode !== 0) {
    s.stop('Push failed');
    p.log.warn(
      `Could not push ${branch} to origin: ${pushResult.stderr.trim()}`
    );
    p.log.warn(
      'Local branch is updated; the mirror copy was not. Skipping pulledPrs config update — the recorded head/lastSyncedAt would not match the mirror.'
    );
    return;
  }
  s.stop(`Pushed ${branch} to origin`);

  try {
    await updateVenforkConfig(cwd, {
      pulledPrs: {
        [branch]: {
          upstreamPrNumber: prNumber,
          upstreamPrUrl: `https://github.com/${(
            await $({ cwd })`git remote get-url upstream`
          ).stdout
            .trim()
            .replace(
              /.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
              '$1'
            )}/pull/${prNumber}`,
          head: headSha,
          lastSyncedAt: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.warn(`Could not update pulledPrs entry: ${msg}`);
  }
}

export async function syncCommand(
  targetBranch?: string,
  options?: { cwd?: string; quiet?: boolean }
): Promise<void> {
  const cwdOpt = options?.cwd ? { cwd: options.cwd } : {};
  const quiet = options?.quiet ?? false;

  if (!quiet) {
    p.intro('🔄 Venfork Sync');
  }

  const s = p.spinner();

  try {
    const repoDir = options?.cwd ?? process.cwd();

    // Branch-specific path: if the targetBranch is a pulled-in upstream PR,
    // refresh it from `pull/<n>/head` instead of running the default-branch
    // +1-commit sync flow.
    if (targetBranch) {
      const initialConfig = await readVenforkConfigFromRepo(repoDir);
      const pulledPr = resolvePulledPr(targetBranch, initialConfig);
      if (pulledPr) {
        await syncPulledPr(targetBranch, pulledPr.prNumber, repoDir, s);
        if (!quiet) {
          p.outro(
            `✨ ${targetBranch} synced with upstream PR #${pulledPr.prNumber}`
          );
        }
        return;
      }
    }

    const config = await readVenforkConfigFromRepo(repoDir);
    const noPublic = config?.mode === 'no-public';

    // Step 1: Fetch from upstream
    s.start('Fetching from upstream');
    await $(cwdOpt)`git fetch upstream`;
    await $(cwdOpt)`git fetch origin`;
    if (!noPublic) {
      await $(cwdOpt)`git fetch public`;
    }
    s.stop('Fetched from all remotes');

    // Step 2: Detect default branch if not specified
    const defaultBranch =
      targetBranch || (await getDefaultBranch('upstream', options?.cwd));
    const scheduleConfig = config?.schedule;
    const enabledWorkflows = config?.enabledWorkflows ?? [];
    const disabledWorkflows = config?.disabledWorkflows ?? [];
    const preserveList = config?.preserve ?? [];

    // Step 3: Check for divergence
    s.start('Checking for divergent commits');

    // `allowPreserved` is asymmetric on purpose: mirror-only files live on
    // origin (the private mirror) and never get pushed to public. So a
    // preserved-only commit on origin is expected and benign, but the same
    // shape on public would mean someone pushed to public outside venfork —
    // which is a real divergence we want to abort on.
    const checkDivergence = async (
      remote: string,
      allowPreserved: boolean
    ): Promise<{ count: number; files: string[] }> => {
      try {
        const result = await $({
          ...cwdOpt,
        })`git rev-list upstream/${defaultBranch}..${remote}/${defaultBranch}`;
        const divergentCommits = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        let count = 0;
        const files = new Set<string>();
        for (const commit of divergentCommits) {
          if (await isWorkflowCommit(commit, options?.cwd)) continue;
          if (
            allowPreserved &&
            (await isPreservedCommit(commit, preserveList, options?.cwd))
          ) {
            continue;
          }
          count += 1;
          for (const file of await changedFilesInCommit(commit, options?.cwd)) {
            files.add(file);
          }
        }
        return { count, files: Array.from(files).sort() };
      } catch {
        // Remote branch might not exist yet (first sync)
        return { count: 0, files: [] };
      }
    };

    const originDivergence = await checkDivergence('origin', true);
    const publicDivergence = noPublic
      ? { count: 0, files: [] as string[] }
      : await checkDivergence('public', false);

    s.stop('Checked for divergence');

    // Step 4: Warn if divergent commits exist
    if (originDivergence.count > 0 || publicDivergence.count > 0) {
      const warnings: string[] = [];
      if (originDivergence.count > 0) {
        warnings.push(
          `  • origin/${defaultBranch} has ${originDivergence.count} commit(s) not in upstream`
        );
      }
      if (publicDivergence.count > 0) {
        warnings.push(
          `  • public/${defaultBranch} has ${publicDivergence.count} commit(s) not in upstream`
        );
      }

      // When origin diverges, surface the changed files and a concrete
      // `venfork preserve add ...` hint. Most likely cause is a mirror-only
      // file the user committed directly (or one whose preserve entry was
      // just removed) — both cases resolve with `preserve add`. Public
      // divergence does NOT get this hint: preserve doesn't apply to public,
      // so suggesting it would mislead.
      const sections: string[] = [warnings.join('\n')];
      if (originDivergence.files.length > 0) {
        sections.push(
          `Files changed by divergent commits on origin/${defaultBranch}:\n${originDivergence.files
            .map((f) => `  • ${f}`)
            .join('\n')}`
        );
        sections.push(
          `If these are mirror-only files you want to keep across sync, add them to preserve:\n  venfork preserve add ${originDivergence.files.join(' ')}`
        );
      }
      sections.push(
        `Otherwise:\n- Rebase or cherry-pick to a feature branch before running sync\n- Force-sync (DESTRUCTIVE — permanently discards the commits): git push origin upstream/${defaultBranch}:refs/heads/${defaultBranch} -f`
      );

      p.log.warn('Divergent commits detected:');
      p.note(sections.join('\n\n'), '⚠️  Warning');

      if (!quiet) {
        p.outro('❌ Sync aborted to prevent data loss');
      }
      process.exit(1);
    }

    // Capture the previous mirror tip BEFORE the force-push so
    // `applyMirrorPlusOneCommit` can read preserved files from it. After the
    // push, `origin/<defaultBranch>` (locally and remotely) points at the
    // upstream tree and the previous mirror state is no longer reachable
    // through that ref.
    const prevTipResult = await $({
      ...cwdOpt,
      reject: false,
    })`git rev-parse --verify origin/${defaultBranch}`;
    const previousMirrorTip =
      prevTipResult.exitCode === 0 ? prevTipResult.stdout.trim() : '';

    // Step 5: Push upstream default branch to origin (and public, in standard mode)
    s.start(
      noPublic
        ? `Syncing ${defaultBranch} to origin`
        : `Syncing ${defaultBranch} to origin and public`
    );

    await $(
      cwdOpt
    )`git push origin upstream/${defaultBranch}:refs/heads/${defaultBranch} --force-with-lease`;
    if (!noPublic) {
      await $(
        cwdOpt
      )`git push public upstream/${defaultBranch}:refs/heads/${defaultBranch} --force-with-lease`;
    }

    s.stop(noPublic ? 'Synced to origin' : 'Synced to all remotes');

    // Step 6: Enforce mirror "+1 commit" model. Runs when schedule is enabled
    // (writes the managed sync workflow + filters upstream workflows) OR when
    // preserve is non-empty (carries mirror-only files forward across sync).
    const scheduleActive = Boolean(
      scheduleConfig?.enabled && scheduleConfig.cron
    );
    if (scheduleActive || preserveList.length > 0) {
      s.start('Re-applying mirror "+1 commit"');
      await applyMirrorPlusOneCommit({
        defaultBranch,
        schedule:
          scheduleActive && scheduleConfig
            ? {
                cron: scheduleConfig.cron,
                mode: noPublic ? 'no-public' : 'standard',
              }
            : null,
        enabledWorkflows,
        disabledWorkflows,
        preserve: preserveList,
        previousMirrorTip,
        cwd: options?.cwd,
      });
      s.stop('Mirror "+1 commit" applied');
    }

    if (!quiet) {
      p.outro(
        noPublic
          ? `✨ Sync complete! origin/${defaultBranch} is now up to date with upstream/${defaultBranch}`
          : `✨ Sync complete! origin/${defaultBranch} and public/${defaultBranch} are now up to date with upstream/${defaultBranch}`
      );
    }
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    if (!quiet) {
      p.outro('❌ Sync failed');
    }
    process.exit(1);
  }
}

/**
 * Schedule command: Configure automated sync via GitHub Actions workflow.
 */
export async function scheduleCommand(
  action?: string,
  value?: string
): Promise<void> {
  p.intro('⏰ Venfork Schedule');
  const repoDir = process.cwd();
  const s = p.spinner();

  try {
    const defaultBranch = await getDefaultBranch('upstream');

    if (action === 'set') {
      const cron = value?.trim();
      if (!cron) {
        p.log.error('Cron expression is required');
        p.outro('Usage: venfork schedule set "<cron>"');
        process.exit(1);
      }
      if (!isValidCronExpression(cron)) {
        p.log.error('Invalid cron expression (expected 5 fields)');
        p.outro('Usage: venfork schedule set "<cron>"');
        process.exit(1);
      }

      s.start('Updating schedule in venfork-config');
      const updatedConfig = await updateVenforkConfig(repoDir, {
        schedule: { enabled: true, cron },
      });
      s.stop('Schedule configuration updated');

      const scheduleMode: 'standard' | 'no-public' =
        updatedConfig.mode === 'no-public' ? 'no-public' : 'standard';

      await $`git fetch origin`;
      s.start('Updating workflow on default branch');
      await updateWorkflowOnOriginDefault(
        defaultBranch,
        generateSyncWorkflow(cron, scheduleMode),
        repoDir
      );
      s.stop('Workflow updated');

      let mirrorPath = '<owner>/<mirror>';
      try {
        const originUrl = (
          await $({ cwd: repoDir })`git remote get-url origin`
        ).stdout.trim();
        const parsed = parseRepoPath(originUrl);
        if (parsed) {
          mirrorPath = parsed;
        }
      } catch {
        // Best-effort: fall back to placeholder.
      }

      p.outro(
        `✨ Scheduled sync enabled\n\nBranch: ${defaultBranch}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}\n\nNext: set the cross-repo push token so the workflow can push to the public fork:\n  gh secret set VENFORK_PUSH_TOKEN --repo ${mirrorPath} --body "$(gh auth token)"\n(skip if VENFORK_PUSH_TOKEN is already configured)`
      );
      return;
    }

    if (action === 'disable') {
      s.start('Disabling schedule in venfork-config');
      const currentConfig = await readVenforkConfigFromRepo(repoDir);
      if (!currentConfig) {
        throw new Error('venfork-config branch not found or invalid');
      }
      await updateVenforkConfig(repoDir, {
        schedule: {
          enabled: false,
          cron: currentConfig.schedule?.cron || '0 * * * *',
        },
      });
      s.stop('Schedule configuration updated');

      await $`git fetch origin`;
      s.start('Removing workflow from default branch');
      await updateWorkflowOnOriginDefault(defaultBranch, null, repoDir);
      s.stop('Workflow removed');

      p.outro(
        `✨ Scheduled sync disabled\n\nBranch: ${defaultBranch}\nWorkflow removed: ${SYNC_WORKFLOW_PATH}`
      );
      return;
    }

    if (action === 'status' || !action) {
      s.start('Reading schedule configuration');
      const config = await readVenforkConfigFromRepo(repoDir);
      s.stop('Configuration loaded');
      if (!config) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const schedule = config.schedule;
      const enabled = Boolean(schedule?.enabled);
      const cron = schedule?.cron || '(not set)';
      p.note(
        `Branch: ${defaultBranch}\nEnabled: ${enabled ? 'yes' : 'no'}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}`,
        'Schedule Status'
      );
      p.outro('✨ Schedule status shown');
      return;
    }

    p.log.error(`Unknown schedule action: ${action}`);
    p.outro(
      'Usage: venfork schedule <status|set <cron>|disable>\nExample: venfork schedule set "0 */6 * * *"'
    );
    process.exit(1);
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Schedule command failed');
    process.exit(1);
  }
}

/**
 * Workflows command: manage workflow allowlist in venfork-config.
 */
export async function workflowsCommand(
  action: 'status' | 'allow' | 'block' | 'clear',
  workflows: string[]
): Promise<void> {
  p.intro('🧩 Venfork Workflows');
  const repoDir = process.cwd();

  try {
    if (action === 'status') {
      const config = await readVenforkConfigFromRepo(repoDir);
      if (!config) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const allowlist = config.enabledWorkflows ?? [];
      const blocklist = config.disabledWorkflows ?? [];
      if (allowlist.length === 0 && blocklist.length === 0) {
        p.note(
          'No workflow policy configured. Mirror keeps all upstream workflows unless schedule logic modifies them.',
          'Workflows Status'
        );
      } else {
        const lines = [
          `enabledWorkflows: ${allowlist.length > 0 ? 'set' : 'not set'}`,
          `disabledWorkflows: ${blocklist.length > 0 ? 'set' : 'not set'}`,
          allowlist.length > 0
            ? `Allowed files:\n${allowlist.map((name) => `- ${name}`).join('\n')}`
            : '',
          blocklist.length > 0
            ? `Blocked files:\n${blocklist.map((name) => `- ${name}`).join('\n')}`
            : '',
          allowlist.length > 0
            ? 'Precedence: enabledWorkflows allowlist overrides disabledWorkflows.'
            : '',
        ].filter((line) => line.length > 0);
        p.note(lines.join('\n'), 'Workflow Policy');
      }
      p.outro('✨ Workflows status shown');
      return;
    }

    if (action === 'clear') {
      await updateVenforkConfig(repoDir, {
        enabledWorkflows: null,
        disabledWorkflows: null,
      });
      p.outro(
        '✨ Workflow policy cleared. Run `venfork sync` to apply on the private mirror default branch.'
      );
      return;
    }

    const normalized = normalizeWorkflowList(workflows);
    if (action === 'allow') {
      await updateVenforkConfig(repoDir, { enabledWorkflows: normalized });
      p.note(
        normalized.map((name) => `- ${name}`).join('\n'),
        'Allowed workflow files'
      );
      p.outro(
        '✨ Workflow allowlist updated. Run `venfork sync` to apply on the private mirror default branch.'
      );
      return;
    }

    await updateVenforkConfig(repoDir, { disabledWorkflows: normalized });
    p.note(
      normalized.map((name) => `- ${name}`).join('\n'),
      'Blocked workflow files'
    );
    p.outro(
      '✨ Workflow blocklist updated. Run `venfork sync` to apply on the private mirror default branch.'
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Workflows command failed');
    process.exit(1);
  }
}

/**
 * Preserve command: manage the `preserve` allowlist of mirror-only file paths
 * carried forward by `venfork sync`. Additive-only — there's no "deny preserve"
 * concept, since preserve already opts into protection rather than out of it.
 */
export async function preserveCommand(
  action: 'list' | 'add' | 'remove' | 'clear',
  paths: string[]
): Promise<void> {
  p.intro('🧷 Venfork Preserve');
  const repoDir = process.cwd();

  try {
    if (action === 'list') {
      const config = await readVenforkConfigFromRepo(repoDir);
      if (!config) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const entries = config.preserve ?? [];
      if (entries.length === 0) {
        p.note(
          'No files preserved. Sync will drop any mirror-only files on every run.',
          'Preserve Status'
        );
      } else {
        p.note(
          entries.map((entry) => `- ${entry}`).join('\n'),
          'Preserved files'
        );
      }
      p.outro('✨ Preserve list shown');
      return;
    }

    if (action === 'clear') {
      await updateVenforkConfig(repoDir, { preserve: null });
      p.outro(
        '✨ Preserve list cleared. Run `venfork sync` to apply on the private mirror default branch.'
      );
      return;
    }

    const validated: string[] = [];
    for (const candidate of paths) {
      const cleaned = normalizePreservePath(candidate);
      if (!cleaned) {
        throw new Error(
          `Invalid preserve path '${candidate}': must be a relative path with no leading '/' or '..' segments.`
        );
      }
      validated.push(cleaned);
    }

    const current = (await readVenforkConfigFromRepo(repoDir))?.preserve ?? [];

    if (action === 'add') {
      const merged = Array.from(new Set([...current, ...validated]));
      await updateVenforkConfig(repoDir, { preserve: merged });
      p.note(
        validated.map((entry) => `- ${entry}`).join('\n'),
        'Added to preserve list'
      );
      p.outro(
        '✨ Preserve list updated. Commit the file(s) to the mirror default branch (if not already), then run `venfork sync`.'
      );
      return;
    }

    // action === 'remove'
    const toRemove = new Set(validated);
    const filtered = current.filter((entry) => !toRemove.has(entry));
    await updateVenforkConfig(repoDir, {
      preserve: filtered.length > 0 ? filtered : null,
    });
    p.note(
      validated.map((entry) => `- ${entry}`).join('\n'),
      'Removed from preserve list'
    );
    p.outro(
      '✨ Preserve list updated. Run `venfork sync` to apply on the private mirror default branch.'
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Preserve command failed');
    process.exit(1);
  }
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
  scheduleEnabled: boolean;
  /** True when the head and base of the upstream PR live in the same repo (no-public mode). */
  noPublic: boolean;
}

/**
 * Resolves remotes, default branch, and schedule state for a staging push.
 * Pure read; no network writes. Throws `BranchNotFoundError` /
 * `RemoteNotFoundError` so callers can render a single failure path.
 */
async function planStaging(branch: string, cwd: string): Promise<StagingPlan> {
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
  const scheduleEnabled = await isScheduleEnabled(cwd);

  return {
    branch,
    pushUrl,
    pushRepoPath,
    pushOwner,
    pushRemote,
    upstreamUrl,
    upstreamRepoPath,
    upstreamDefaultBranch,
    scheduleEnabled,
    noPublic,
  };
}

/**
 * Pushes the branch to the public fork, stripping the internal workflow
 * commit when scheduled sync is enabled. Returns the SHA pushed.
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

  if (plan.scheduleEnabled) {
    await $({ cwd })`git fetch upstream`;
    await $({ cwd })`git fetch origin`;
    s.start(`Preparing sanitized branch for ${target} staging`);
    const stageHead = await buildPublicStageHeadWithoutWorkflowCommit(
      plan.branch,
      plan.upstreamDefaultBranch,
      cwd
    );
    s.stop('Prepared sanitized branch');

    s.start(`Pushing sanitized branch to ${target}`);
    if (plan.noPublic) {
      // URL push: `--force-with-lease=<ref>` (no expect) relies on a
      // remote-tracking ref that doesn't exist for URL pushes, so resolve
      // the remote tip explicitly via ls-remote and pass it as the lease.
      const ls = await $({
        cwd,
        reject: false,
      })`git ls-remote --exit-code ${pushDest} refs/heads/${plan.branch}`;
      if (ls.exitCode === 0) {
        const expectedSha = ls.stdout.trim().split(/\s+/)[0] ?? '';
        await $({
          cwd,
        })`git push ${pushDest} ${stageHead}:refs/heads/${plan.branch} --force-with-lease=refs/heads/${plan.branch}:${expectedSha}`;
      } else {
        await $({
          cwd,
        })`git push ${pushDest} ${stageHead}:refs/heads/${plan.branch}`;
      }
    } else {
      // Standard mode: remote name with the implicit-lease form (lease
      // value comes from refs/remotes/public/<branch>).
      if (await remoteBranchExists(plan.pushRemote, plan.branch)) {
        await $({
          cwd,
        })`git push ${plan.pushRemote} ${stageHead}:refs/heads/${plan.branch} --force-with-lease=refs/heads/${plan.branch}`;
      } else {
        await $({
          cwd,
        })`git push ${plan.pushRemote} ${stageHead}:refs/heads/${plan.branch}`;
      }
    }
    s.stop('Push successful');
    return stageHead;
  }

  s.start(`Pushing to ${target}`);
  await $({ cwd })`git push ${pushDest} ${plan.branch}`;
  s.stop('Push successful');
  const headResult = await $({
    cwd,
  })`git rev-parse ${plan.branch}`;
  return headResult.stdout.trim();
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

interface InternalPrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
}

const VENFORK_INTERNAL_OPEN_RE = /<!--\s*venfork:internal\s*-->/g;
const VENFORK_INTERNAL_CLOSE_RE = /<!--\s*\/venfork:internal\s*-->/g;

interface RedactionMarker {
  type: 'open' | 'close';
  start: number;
  end: number;
}

/**
 * Removes properly-nested `<!-- venfork:internal -->...<!-- /venfork:internal -->`
 * blocks from `body`. Walks markers in document order and tracks depth, so
 * nested pairs collapse correctly: every char between the outermost open and
 * its matching close is dropped (including any inner pairs).
 *
 * Edge cases:
 *  - Unmatched close marker: dropped, surrounding content preserved.
 *  - Unmatched open marker: content from that open to end-of-input is
 *    dropped (defensive — a missing close shouldn't leak intended-private
 *    content upstream).
 *  - Whitespace inside the markers is tolerated (`<!-- venfork:internal -->`
 *    and `<!--venfork:internal-->` both match).
 *
 * @internal Exported for unit testing; not part of the public API.
 */
export function stripInternalBlocks(body: string): string {
  const markers: RedactionMarker[] = [];
  // Reset lastIndex on the global regexes — they're module-scoped and would
  // otherwise carry state across calls.
  VENFORK_INTERNAL_OPEN_RE.lastIndex = 0;
  VENFORK_INTERNAL_CLOSE_RE.lastIndex = 0;

  for (
    let m = VENFORK_INTERNAL_OPEN_RE.exec(body);
    m !== null;
    m = VENFORK_INTERNAL_OPEN_RE.exec(body)
  ) {
    markers.push({ type: 'open', start: m.index, end: m.index + m[0].length });
  }
  for (
    let m = VENFORK_INTERNAL_CLOSE_RE.exec(body);
    m !== null;
    m = VENFORK_INTERNAL_CLOSE_RE.exec(body)
  ) {
    markers.push({ type: 'close', start: m.index, end: m.index + m[0].length });
  }
  markers.sort((a, b) => a.start - b.start);

  let result = '';
  let cursor = 0;
  let depth = 0;
  for (const marker of markers) {
    if (marker.type === 'open') {
      if (depth === 0) {
        // Surfacing into a new redacted block — emit content up to here.
        result += body.slice(cursor, marker.start);
      }
      depth += 1;
      cursor = marker.end;
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      cursor = marker.end;
    } else {
      // Unmatched close marker. Keep the content before it; drop the
      // marker itself.
      result += body.slice(cursor, marker.start);
      cursor = marker.end;
    }
  }
  if (depth === 0) {
    result += body.slice(cursor);
  }
  // depth > 0 here means an unclosed open marker — content from the
  // unmatched open to end-of-input is intentionally dropped.
  return result;
}

/**
 * Looks up the most relevant internal PR for `branch` on the private mirror.
 * When `pinnedNumber` is set, fetches that exact PR via `gh pr view` (skips
 * the list lookup). Otherwise prefers the most recent open PR, then the most
 * recent of any state. Returns null if none exists or the lookup fails — the
 * caller falls back to a generated synthetic body.
 */
async function findInternalPr(
  mirrorRepoPath: string,
  branch: string,
  cwd: string,
  pinnedNumber?: number
): Promise<InternalPrInfo | null> {
  if (pinnedNumber !== undefined) {
    const result = await $({
      cwd,
      reject: false,
    })`gh pr view ${pinnedNumber} --repo ${mirrorRepoPath} --json number,url,title,body`;
    if (result.exitCode !== 0) {
      return null;
    }
    try {
      return JSON.parse(result.stdout) as InternalPrInfo;
    } catch {
      return null;
    }
  }
  // Prefer an open PR; if none, take the most recent of any state.
  // Pass each flag/value as a separate execa interpolation — passing
  // `--state open` as a single string makes execa treat it as one arg
  // and gh silently filters wrong (returns zero results).
  for (const state of ['open', 'all'] as const) {
    const result = await $({
      cwd,
      reject: false,
    })`gh pr list --repo ${mirrorRepoPath} --head ${branch} --state ${state} --json number,url,title,body --limit 1`;
    if (result.exitCode !== 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(result.stdout) as InternalPrInfo[];
      if (parsed.length > 0) {
        return parsed[0];
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Strips `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks via
 * a depth-tracking pass (see `stripInternalBlocks`) and appends a footer
 * linking back to the internal review PR or issue. Only the team can follow
 * that link; the upstream maintainer sees only that there *was* an internal
 * review.
 */
function translateInternalBody(
  body: string,
  internalUrl: string | undefined,
  kind: 'pr' | 'issue' = 'pr'
): string {
  const stripped = stripInternalBlocks(body).trim();
  const footer = internalUrl
    ? kind === 'issue'
      ? `\n\n> Upstreamed from internal issue (${internalUrl}).`
      : `\n\n> Upstreamed from internal review (${internalUrl}).`
    : '';
  return `${stripped}${footer}`.trim();
}

/**
 * Generates a synthetic upstream PR body from the branch's commit log when no
 * internal review PR was found. Lists the non-merge commits in
 * `upstream/<defaultBranch>..<branch>` so the upstream maintainer sees what
 * the change actually is, rather than a "please add a description" placeholder.
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
  })`git log --oneline --no-merges upstream/${defaultBranch}..${branch}`;
  if (log.exitCode !== 0 || !log.stdout.trim()) {
    return 'Staged from a private mirror. No internal review PR was open at stage time.';
  }
  const lines = log.stdout
    .trim()
    .split('\n')
    .map((line) => `- ${line}`)
    .join('\n');
  return `Staged from a private mirror. Commits in this branch:\n\n${lines}\n\n_(No internal review PR was found at stage time.)_`;
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
      title: override.title ?? internal.title,
      body: override.body ?? translateInternalBody(internal.body, internal.url),
    };
  }
  return {
    title: override.title ?? branch,
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

async function findMirrorRepoPath(cwd: string): Promise<string | null> {
  const result = await $({
    cwd,
    reject: false,
  })`git remote get-url origin`;
  if (result.exitCode !== 0) return null;
  const path = parseRepoPath(result.stdout.trim());
  return path || null;
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

  const isAuthenticated = await checkGhAuth();
  if (!isAuthenticated) {
    throw new AuthenticationError();
  }

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
      const previewBody =
        translatedBody.length > 800
          ? `${translatedBody.slice(0, 800)}\n…(truncated; full body sent on submit)`
          : translatedBody;
      p.note(previewBody || '(empty)', 'Upstream PR body preview');
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

export interface PullRequestOptions {
  /** Local + mirror branch name to write the PR's commits to. */
  branchName?: string;
  /** When false, only fetch locally; do not push to the mirror. */
  push?: boolean;
}

/**
 * Resolves a `<pr>` argument (bare number or PR URL) to a numeric PR id.
 * For URL form, also returns the parsed owner/repo so the caller can sanity
 * check it matches the upstream remote.
 */
function resolvePullRequestArg(
  pr: string,
  upstreamRepoPath: string
): { number: number; sourceRepoPath?: string } {
  const trimmed = pr.trim();
  if (/^\d+$/.test(trimmed)) {
    return { number: Number(trimmed) };
  }
  const match = trimmed.match(
    /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/pull\/(\d+)/
  );
  if (!match) {
    throw new Error(
      `Could not parse PR reference: ${pr}. Expected an integer or a github.com/<owner>/<repo>/pull/<n> URL.`
    );
  }
  const [, sourceRepoPath, num] = match;
  if (sourceRepoPath !== upstreamRepoPath) {
    throw new Error(
      `Refused to use PR URL ${pr}: it points to ${sourceRepoPath}, but the upstream remote is ${upstreamRepoPath}. If this is intentional, pass the PR number directly (\`venfork pull-request ${num}\`).`
    );
  }
  return { number: Number(num), sourceRepoPath };
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
    throw new Error(
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
 */
export async function pullRequestCommand(
  pr: string | undefined,
  options: PullRequestOptions = {}
): Promise<void> {
  p.intro('🔀 Venfork Pull Request');

  const isAuthenticated = await checkGhAuth();
  if (!isAuthenticated) {
    throw new AuthenticationError();
  }

  if (!pr) {
    p.log.error('PR number or URL is required');
    p.outro(
      'Usage: venfork pull-request <pr-number-or-url> [--branch-name <override>] [--no-push]'
    );
    process.exit(1);
  }

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
      throw new Error(
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
      throw new Error(
        `Local branch '${localBranch}' already exists. Pass --branch-name <override> to use a different name, or delete the existing branch first.`
      );
    }

    s.start(`Fetching pull/${prNumber}/head from upstream`);
    const fetchRefspec = `pull/${prNumber}/head:${localBranch}`;
    const fetchResult = await $({
      cwd: repoDir,
      reject: false,
    })`git fetch upstream ${fetchRefspec}`;
    if (fetchResult.exitCode !== 0) {
      throw new Error(
        `git fetch upstream ${fetchRefspec} failed. This can happen if the PR's source branch was deleted, or if the local branch already exists at a different commit (try deleting or renaming it first). Stderr:\n${fetchResult.stderr.trim()}`
      );
    }
    const headSha = (
      await $({ cwd: repoDir })`git rev-parse ${localBranch}`
    ).stdout.trim();
    s.stop(`Fetched ${headSha.slice(0, 9)} → ${localBranch}`);

    let pushedToMirror = false;
    if (push) {
      s.start(`Pushing ${localBranch} to origin`);
      const pushResult = await $({
        cwd: repoDir,
        reject: false,
      })`git push origin ${localBranch}`;
      if (pushResult.exitCode !== 0) {
        s.stop('Push failed');
        p.log.warn(
          `Could not push ${localBranch} to origin: ${pushResult.stderr.trim()}`
        );
        p.log.warn(
          'The local branch is still available for review, but no pulledPrs entry was recorded — `venfork sync` will not know how to refresh it until the next successful push.'
        );
      } else {
        s.stop(`Pushed ${localBranch} to origin`);
        pushedToMirror = true;
      }
    }

    if (!pushedToMirror) {
      // Two paths reach here:
      // 1. Push failed: warned above, branch is local-only.
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
      p.outro(`✨ Pull request fetched locally (${reason})`);
      return;
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
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Pull request import failed');
    process.exit(1);
  }
}

interface IssueMeta {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  author?: { login: string };
}

async function readIssue(
  repoPath: string,
  number: number,
  cwd: string
): Promise<IssueMeta> {
  const result = await $({
    cwd,
    reject: false,
  })`gh issue view ${number} --repo ${repoPath} --json number,url,title,body,state,author`;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read issue #${number} from ${repoPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return JSON.parse(result.stdout) as IssueMeta;
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

  const isAuthenticated = await checkGhAuth();
  if (!isAuthenticated) {
    throw new AuthenticationError();
  }

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

      const translatedBody = translateInternalBody(
        internal.body,
        internal.url,
        'issue'
      );
      const upstreamTitle = options.title ?? internal.title;

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
    s.stop(`Read: ${upstream.title} (${upstream.state})`);

    const internalTitle =
      options.title ?? `[upstream #${upstream.number}] ${upstream.title}`;
    const internalBody = `${upstream.body || '(no body provided)'}\n\n> Pulled from upstream issue: ${upstream.url}\n> Author: ${upstream.author?.login ?? '(unknown)'}\n> State: ${upstream.state}`;

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

/**
 * Status command: Show current repository setup and configuration
 */
export async function statusCommand(): Promise<void> {
  p.intro('📊 Venfork Status');

  // Check if we're in a git repository
  const inGitRepo = await isGitRepository();
  if (!inGitRepo) {
    throw new NotInRepositoryError();
  }

  // Get current branch
  const currentBranch = await getCurrentBranch();

  // Get remotes
  const remotes = await getRemotes();
  const hasOrigin = await hasRemote('origin');
  const hasPublic = await hasRemote('public');
  const hasUpstream = await hasRemote('upstream');

  // Mode is read from venfork-config; absent ⇒ standard. Use a best-effort
  // read so a missing/unreadable config doesn't break `status`.
  let mode: 'standard' | 'no-public' = 'standard';
  try {
    const cfgForMode = await readVenforkConfigFromRepo(process.cwd());
    if (cfgForMode?.mode === 'no-public') {
      mode = 'no-public';
    }
  } catch {
    // Fall through to 'standard'.
  }
  const noPublic = mode === 'no-public';

  // Check if setup is complete
  const isSetupComplete = hasOrigin && hasUpstream && (noPublic || hasPublic);

  // Display git remotes
  if (Object.keys(remotes).length > 0) {
    const remotesText = Object.entries(remotes)
      .map(([name, urls]) => {
        const fetchUrl = urls.fetch || '(not set)';
        const pushUrl = urls.push || '(not set)';
        return `${name}:\n  fetch: ${fetchUrl}\n  push:  ${pushUrl}`;
      })
      .join('\n\n');

    p.note(remotesText, 'Git Remotes');
  } else {
    p.note('No remotes configured', 'Git Remotes');
  }

  // Display status
  const statusLines = [
    `Current branch: ${currentBranch || '(detached HEAD)'}`,
    `Mode: ${mode}`,
    '',
    'Setup status:',
    `  ${hasOrigin ? '✓' : '✗'} origin (private mirror)`,
  ];
  if (!noPublic) {
    statusLines.push(`  ${hasPublic ? '✓' : '✗'} public (public fork)`);
  }
  statusLines.push(`  ${hasUpstream ? '✓' : '✗'} upstream (original repo)`);

  p.note(statusLines.join('\n'), 'Repository Status');

  // Surface PR/issue linkages from venfork-config (best-effort — quietly skip
  // if the branch is missing or the read fails).
  if (isSetupComplete) {
    try {
      const cfg = await readVenforkConfigFromRepo(process.cwd());
      const linkageBlocks: string[] = [];

      const formatDate = (iso: string): string => {
        try {
          return new Date(iso).toISOString().slice(0, 10);
        } catch {
          return iso;
        }
      };

      const ship = cfg?.shippedBranches ?? {};
      if (Object.keys(ship).length > 0) {
        const lines = Object.entries(ship)
          .map(
            ([branch, entry]) =>
              `  ${branch} → ${entry.upstreamPrUrl} (${formatDate(entry.shippedAt)})`
          )
          .join('\n');
        linkageBlocks.push(`Shipped branches:\n${lines}`);
      }

      const pulled = cfg?.pulledPrs ?? {};
      if (Object.keys(pulled).length > 0) {
        const lines = Object.entries(pulled)
          .map(
            ([branch, entry]) =>
              `  ${branch} → ${entry.upstreamPrUrl} (last sync ${formatDate(entry.lastSyncedAt)})`
          )
          .join('\n');
        linkageBlocks.push(`Pulled PRs:\n${lines}`);
      }

      const shippedIssues = cfg?.shippedIssues ?? {};
      if (Object.keys(shippedIssues).length > 0) {
        const lines = Object.entries(shippedIssues)
          .map(
            ([, entry]) =>
              `  #${entry.internalIssueNumber} → ${entry.upstreamIssueUrl} (${formatDate(entry.shippedAt)})`
          )
          .join('\n');
        linkageBlocks.push(`Shipped issues:\n${lines}`);
      }

      const pulledIssues = cfg?.pulledIssues ?? {};
      if (Object.keys(pulledIssues).length > 0) {
        const lines = Object.entries(pulledIssues)
          .map(
            ([, entry]) =>
              `  #${entry.internalIssueNumber} ← ${entry.upstreamIssueUrl} (${formatDate(entry.pulledAt)})`
          )
          .join('\n');
        linkageBlocks.push(`Pulled issues:\n${lines}`);
      }

      if (linkageBlocks.length > 0) {
        p.note(linkageBlocks.join('\n\n'), 'Linkages');
      }
    } catch {
      // Best-effort; status should never fail because of a config read.
    }
  }

  // Show appropriate outro
  if (isSetupComplete) {
    p.outro('✨ Venfork is fully configured!');
  } else {
    const missingRemotes = [];
    if (!hasOrigin) missingRemotes.push('origin');
    if (!noPublic && !hasPublic) missingRemotes.push('public');
    if (!hasUpstream) missingRemotes.push('upstream');

    p.note(
      `Run venfork setup <upstream> to configure:\n  ${missingRemotes.join(', ')}`,
      'Next Steps'
    );
    p.outro('⚠️  Setup incomplete');
  }
}

/**
 * Show help information
 */
export function showHelp(): void {
  p.intro('🔧 Venfork - Private Repository Mirrors for Vendor Development');

  p.note(
    `venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--no-public]
  Create private mirror + public fork for vendor workflow
  <upstream>: GitHub HTTPS/SSH URL, or shorthand owner/repo (e.g. facebook/react)

  Options:
  • --org <name>       Create repos under organization instead of user account
  • --fork-name <name> Public fork repo name under owner (gh repo fork --fork-name).
                       Use when upstream is already owner/repo so the fork needs a different name.
  • --no-public        Skip the public fork hop entirely. Only origin + upstream are
                       configured; \`venfork stage\` later pushes branches directly to upstream.
                       Use when you own the upstream repo (no need to round-trip through a fork).
                       Mutually exclusive with --fork-name.

  Creates:
  • Private mirror (yourname/project-private) - internal work
  • Public fork (yourname/project) - staging for upstream (omitted with --no-public)
  • Configures remotes: origin, public, upstream (public omitted with --no-public)

venfork clone <vendor-repo> [--no-public] [--upstream <url>]
  Clone an existing vendor setup and configure remotes automatically
  <vendor-repo>: URL or owner/repo for the private mirror

  Reads layout (mode + URLs) from the venfork-config branch when present.
  Falls back to auto-detection when the branch is absent (legacy mirrors):
  • Public fork (strips -private suffix)
  • Upstream repository (from public fork's parent)
  • Configures three remotes (origin, public, upstream)

  Options (only meaningful when venfork-config is absent):
  • --no-public        Declare a no-public layout (origin + upstream only)
  • --upstream <url>   Provide the upstream URL explicitly (skips auto-detect/prompt)

venfork status
  Show current repository setup and configuration
  Check which remotes are configured and setup completion

venfork sync [branch]
  Update default branches of origin and public to match upstream
  Re-stamps private default branch as upstream + one internal workflow commit when schedule is enabled
  Applies workflow filtering from enabledWorkflows/disabledWorkflows policy
  Syncs main/master branch without affecting your current work

venfork schedule <status|set <cron>|disable>
  Manage scheduled sync config stored in venfork-config
  Set writes/removes ${SYNC_WORKFLOW_PATH} on the private mirror default branch

venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>] [--internal-pr <n>] [--no-update-existing]
  Push branch to public fork for PR to upstream
  When schedule is enabled, strips internal workflow commit before public push
  With --pr, also opens the upstream PR using the internal-review PR's body
    (with <!-- venfork:internal -->...<!-- /venfork:internal --> blocks redacted)
  Options:
  • --internal-pr <n>      Pin a specific internal review PR number (skips most-recent-open lookup)
  • --no-update-existing   Do not update an already-open upstream PR body when staging
  This is when your work becomes visible to the client

venfork pull-request <pr-number-or-url> [--branch-name <name>] [--no-push]
  Bring a third-party upstream PR into the mirror for internal review
  Fetches pull/<n>/head from upstream into a new branch (default: upstream-pr/<n>)
  Pushes the branch to origin so the team can see it
  Refresh later with: venfork sync <branch>

venfork issue <stage|pull> <number-or-url> [--title <text>]
  Move issue context between the private mirror and upstream
  • stage: read internal mirror issue, strip venfork:internal blocks,
    open the upstream counterpart, record linkage in venfork-config
  • pull: read upstream issue, open an internal triage issue on the mirror,
    record linkage. No comment sync — the linkage is one-shot.

venfork workflows <status|allow|block|clear> [workflow-file ...]
  Configure workflow allowlist/blocklist policy in venfork-config

venfork preserve <list|add|remove|clear> [path ...]
  Carry mirror-only files (e.g. caller workflows) forward across \`venfork sync\`
  Each entry is a repo-relative path read from the previous origin tip on every sync
  Upstream wins on collision; missing source aborts sync until the file is committed`,
    'Available Commands'
  );

  p.note(
    `# One-time setup
venfork setup git@github.com:awesome/project.git
# or shorthand:
venfork setup awesome/project

# Or for organization repos:
venfork setup git@github.com:awesome/project.git --org my-company

# Same org as upstream: give the public fork a different repo name
venfork setup my-org/lib.git my-org-lib-private --org my-org --fork-name lib-public

cd project-private

# Work privately (juniors can learn here!)
git checkout -b feature/new-thing
# ... work, mistakes, learning, iteration ...
git push origin feature/new-thing
# Still private! Create internal PR for team review

# After team approval, stage for upstream and open the PR in one go
venfork stage feature/new-thing --pr
# NOW visible on public fork; upstream PR is opened with your internal review body

# Bring a third-party upstream PR in for internal review
venfork pull-request 1234
# Refresh as the contributor pushes updates: venfork sync upstream-pr/1234`,
    'Example Workflow'
  );

  p.note(
    `VENFORK_ORG - Default organization for repo creation
  Set this to avoid typing --org every time

  Priority:
  1. --org flag (highest priority)
  2. VENFORK_ORG environment variable
  3. Personal account (with confirmation prompt)

  Example:
  export VENFORK_ORG=my-company
  venfork setup <url>  # Uses my-company automatically`,
    'Environment Variables'
  );

  p.outro('Built for teams who need private vendor workflows');
}

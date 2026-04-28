import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  createConfigBranch,
  fetchVenforkConfig,
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

async function applyScheduledWorkflowCommit(
  defaultBranch: string,
  cron: string,
  enabledWorkflows: string[],
  disabledWorkflows: string[],
  cwd?: string
): Promise<void> {
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
    await mkdir(path.join(tempDir, '.github', 'workflows'), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, SYNC_WORKFLOW_PATH),
      generateSyncWorkflow(cron)
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
  publicUrl: string,
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

  await setOrAdd('public', publicUrl);
  await setOrAdd('upstream', upstreamUrl);
  await $({ cwd })`git remote set-url --push upstream DISABLE`;
}

/**
 * Setup command: Create private mirror and public fork
 *
 * @param publicForkRepoName - Optional GitHub repo name for the public fork under `owner` (see `gh repo fork --fork-name`). Defaults to the upstream repo basename. Use when the fork must differ (e.g. same org as upstream).
 */
export async function setupCommand(
  upstreamUrl?: string,
  privateMirrorName?: string,
  organization?: string,
  publicForkRepoName?: string
): Promise<void> {
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
    const publicForkUrl = `git@github.com:${owner}/${publicForkName}.git`;

    // Step 1: Create public fork (or accept an existing fork under this owner)
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

    let forkPreexisted = false;
    if (forkResult.exitCode !== 0) {
      if (publicForkFullName === upstreamRepoPath && !useForkNameFlag) {
        throw new Error(
          `The upstream repo is already under ${owner}. Use --fork-name to give the public fork a different name.`
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
    await createConfigBranch(repoDir, publicForkUrl, config.upstreamUrl);
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
      `Private Mirror: https://github.com/${privateMirrorGhPath} (for internal work)
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
export async function cloneCommand(vendorRepoUrl?: string): Promise<void> {
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

    let publicForkUrl: string;
    let upstreamUrl: string;

    if (config) {
      // Config found! Use the URLs from config
      publicForkUrl = config.publicForkUrl;
      upstreamUrl = config.upstreamUrl;

      const publicRepoPath = parseRepoPath(publicForkUrl);
      const upstreamRepoPath = parseRepoPath(upstreamUrl);

      s.stop('Configuration found');
      p.log.success(`✓ Using config from venfork-config branch`);
      p.note(
        `Public fork: ${publicRepoPath}\nUpstream: ${upstreamRepoPath}`,
        'Configuration'
      );
    } else {
      // No config found, fall back to auto-detection
      s.stop('No configuration found, using auto-detection');

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
        p.note(`Tried: ${owner}/${publicRepoName}`, 'Detection Failed');

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

      // Step 3b: Auto-detect upstream from public fork's parent
      s.start('Detecting upstream repository');

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

    // Step 4: Configure remotes
    s.start('Configuring git remotes');

    // origin is already configured from clone

    // Add public fork remote
    await $({ cwd: vendorRepoName })`git remote add public ${publicForkUrl}`;

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
    p.log.warn('Local branch is updated; the mirror copy was not.');
  } else {
    s.stop(`Pushed ${branch} to origin`);
  }

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

    // Step 1: Fetch from upstream
    s.start('Fetching from upstream');
    await $(cwdOpt)`git fetch upstream`;
    await $(cwdOpt)`git fetch origin`;
    await $(cwdOpt)`git fetch public`;
    s.stop('Fetched from all remotes');

    // Step 2: Detect default branch if not specified
    const defaultBranch =
      targetBranch || (await getDefaultBranch('upstream', options?.cwd));
    const config = await readVenforkConfigFromRepo(repoDir);
    const scheduleConfig = config?.schedule;
    const enabledWorkflows = config?.enabledWorkflows ?? [];
    const disabledWorkflows = config?.disabledWorkflows ?? [];

    // Step 3: Check for divergence
    s.start('Checking for divergent commits');

    const checkDivergence = async (remote: string): Promise<number> => {
      try {
        const result = await $({
          ...cwdOpt,
        })`git rev-list upstream/${defaultBranch}..${remote}/${defaultBranch}`;
        const divergentCommits = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        let userFacingDivergence = 0;
        for (const commit of divergentCommits) {
          if (!(await isWorkflowCommit(commit, options?.cwd))) {
            userFacingDivergence += 1;
          }
        }
        return userFacingDivergence;
      } catch {
        // Remote branch might not exist yet (first sync)
        return 0;
      }
    };

    const originDivergence = await checkDivergence('origin');
    const publicDivergence = await checkDivergence('public');

    s.stop('Checked for divergence');

    // Step 4: Warn if divergent commits exist
    if (originDivergence > 0 || publicDivergence > 0) {
      const warnings: string[] = [];
      if (originDivergence > 0) {
        warnings.push(
          `  • origin/${defaultBranch} has ${originDivergence} commit(s) not in upstream`
        );
      }
      if (publicDivergence > 0) {
        warnings.push(
          `  • public/${defaultBranch} has ${publicDivergence} commit(s) not in upstream`
        );
      }

      p.log.warn('Divergent commits detected:');
      p.note(
        `${warnings.join('\n')}

This suggests commits were made directly to the default branch.
Force syncing will LOSE these commits.

To preserve them: manually rebase or cherry-pick before running sync.
To force sync anyway: git push origin upstream/${defaultBranch}:refs/heads/${defaultBranch} -f`,
        '⚠️  Warning'
      );

      if (!quiet) {
        p.outro('❌ Sync aborted to prevent data loss');
      }
      process.exit(1);
    }

    // Step 5: Push upstream default branch to origin and public
    s.start(`Syncing ${defaultBranch} to origin and public`);

    await $(
      cwdOpt
    )`git push origin upstream/${defaultBranch}:refs/heads/${defaultBranch} --force-with-lease`;
    await $(
      cwdOpt
    )`git push public upstream/${defaultBranch}:refs/heads/${defaultBranch} --force-with-lease`;

    s.stop('Synced to all remotes');

    // Step 6: Enforce mirror "+1 commit" model for scheduled sync workflow.
    // Scheduling config lives on `venfork-config`; when enabled we re-stamp
    // one deterministic workflow commit on top of upstream.
    if (scheduleConfig?.enabled && scheduleConfig.cron) {
      s.start('Re-applying scheduled sync workflow commit');
      await applyScheduledWorkflowCommit(
        defaultBranch,
        scheduleConfig.cron,
        enabledWorkflows,
        disabledWorkflows,
        options?.cwd
      );
      s.stop('Scheduled workflow commit normalized');
    }

    if (!quiet) {
      p.outro(
        `✨ Sync complete! origin/${defaultBranch} and public/${defaultBranch} are now up to date with upstream/${defaultBranch}`
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
      await updateVenforkConfig(repoDir, {
        schedule: { enabled: true, cron },
      });
      s.stop('Schedule configuration updated');

      await $`git fetch origin`;
      s.start('Updating workflow on default branch');
      await updateWorkflowOnOriginDefault(
        defaultBranch,
        generateSyncWorkflow(cron),
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
 * Read-only snapshot of the state needed to stage a branch. Computed before
 * any user confirmation so the caller can show a preview, and reused for the
 * actual push (`executeStagingPush`) and any follow-on work (e.g. opening an
 * upstream PR in `shipCommand`).
 */
export interface StagingPlan {
  branch: string;
  publicUrl: string;
  publicRepoPath: string;
  upstreamUrl: string;
  upstreamRepoPath: string;
  upstreamDefaultBranch: string;
  scheduleEnabled: boolean;
  /** owner of the public fork — first half of `publicRepoPath`. */
  publicOwner: string;
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

  const publicUrlResult = await $({
    cwd,
    reject: false,
  })`git remote get-url public`;
  if (publicUrlResult.exitCode !== 0) {
    throw new RemoteNotFoundError('public');
  }
  const publicUrl = publicUrlResult.stdout.trim();
  const publicRepoPath = parseRepoPath(publicUrl);
  const publicOwner = publicRepoPath.split('/')[0] ?? '';

  const upstreamUrlResult = await $({
    cwd,
    reject: false,
  })`git remote get-url upstream`;
  if (upstreamUrlResult.exitCode !== 0) {
    throw new RemoteNotFoundError('upstream');
  }
  const upstreamUrl = upstreamUrlResult.stdout.trim();
  const upstreamRepoPath = parseRepoPath(upstreamUrl);

  const upstreamDefaultBranch = await getDefaultBranch('upstream');
  const scheduleEnabled = await isScheduleEnabled(cwd);

  return {
    branch,
    publicUrl,
    publicRepoPath,
    upstreamUrl,
    upstreamRepoPath,
    upstreamDefaultBranch,
    scheduleEnabled,
    publicOwner,
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
  if (plan.scheduleEnabled) {
    await $({ cwd })`git fetch upstream`;
    await $({ cwd })`git fetch origin`;
    s.start('Preparing sanitized branch for public staging');
    const stageHead = await buildPublicStageHeadWithoutWorkflowCommit(
      plan.branch,
      plan.upstreamDefaultBranch,
      cwd
    );
    s.stop('Prepared sanitized branch');

    s.start('Pushing sanitized branch to public fork');
    if (await remoteBranchExists('public', plan.branch)) {
      await $({
        cwd,
      })`git push public ${stageHead}:refs/heads/${plan.branch} --force-with-lease=refs/heads/${plan.branch}`;
    } else {
      await $({
        cwd,
      })`git push public ${stageHead}:refs/heads/${plan.branch}`;
    }
    s.stop('Push successful');
    return stageHead;
  }

  s.start('Pushing to public fork');
  await $({ cwd })`git push public ${plan.branch}`;
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
}

interface InternalPrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
}

const VENFORK_INTERNAL_REDACTION_RE =
  /<!--\s*venfork:internal\s*-->[\s\S]*?<!--\s*\/venfork:internal\s*-->/g;

/**
 * Looks up the most relevant internal PR for `branch` on the private mirror.
 * Prefers the most recent open PR; falls back to the most recent of any state.
 * Returns null if none exists or the lookup fails (network/rate limit) — the
 * caller falls back to a synthetic body.
 */
async function findInternalPr(
  mirrorRepoPath: string,
  branch: string,
  cwd: string
): Promise<InternalPrInfo | null> {
  // Prefer an open PR; if none, take the most recent of any state.
  for (const stateFlag of ['--state open', '--state all']) {
    const result = await $({
      cwd,
      reject: false,
    })`gh pr list --repo ${mirrorRepoPath} --head ${branch} ${stateFlag} --json number,url,title,body --limit 1`;
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
 * Strips `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks and
 * appends a footer linking back to the internal review PR (only the team can
 * follow that link; the upstream maintainer sees only that there *was* an
 * internal review).
 */
function translateInternalBody(
  body: string,
  internalPrUrl: string | undefined
): string {
  const stripped = body.replace(VENFORK_INTERNAL_REDACTION_RE, '').trim();
  const footer = internalPrUrl
    ? `\n\n> Upstreamed from internal review (${internalPrUrl}).`
    : '';
  return `${stripped}${footer}`.trim();
}

/**
 * Build the body and title for the upstream PR. Falls back to a synthetic body
 * keyed off the branch name when there's no internal PR to translate.
 */
function buildUpstreamPrPayload(
  branch: string,
  internal: InternalPrInfo | null,
  override: { title?: string; body?: string }
): { title: string; body: string } {
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
      `Branch staged from a venfork-managed private mirror. No internal review PR found for \`${branch}\`; please add a description.`,
  };
}

/**
 * Creates the upstream PR via gh and returns its URL. Surfaces the duplicate-PR
 * case ("already exists") cleanly so the caller can recover.
 */
async function createUpstreamPr(args: {
  upstreamRepoPath: string;
  publicOwner: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  cwd: string;
}): Promise<{ url: string; alreadyExists: boolean }> {
  const head = `${args.publicOwner}:${args.branch}`;
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
      'Usage: venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>]'
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
        internalPr = await findInternalPr(mirrorRepoPath, plan.branch, repoDir);
      }
      const payload = buildUpstreamPrPayload(plan.branch, internalPr, {
        title: options.title,
      });
      prTitle = payload.title;
      translatedBody = payload.body;
      s.stop(
        internalPr
          ? `Internal PR found: ${internalPr.url}`
          : 'No internal PR found — using synthetic body'
      );
    }

    const detailLines = [
      `Branch '${plan.branch}' will be pushed to your public fork.`,
      'This makes your work visible and ready for PR to upstream.',
      '',
      `  From: Private vendor repo (current)`,
      `  To:   ${plan.publicUrl}`,
      `  PR:   ${plan.publicRepoPath} → ${plan.upstreamRepoPath}`,
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

    const shouldStage = await p.confirm({
      message: createPr
        ? 'Push to public fork and open the upstream PR?'
        : 'Push to public fork?',
      initialValue: false,
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
          publicOwner: plan.publicOwner,
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

    const prUrl = `https://github.com/${plan.upstreamRepoPath}/compare/${plan.upstreamDefaultBranch}...${plan.publicOwner}:${plan.branch}?expand=1`;

    if (createPr && upstreamPrUrl) {
      const lines = [`Upstream PR: ${upstreamPrUrl}`];
      if (internalPr) {
        lines.push(`Internal review: ${internalPr.url}`);
      }
      p.note(lines.join('\n'), 'Next Steps');
    } else {
      p.note(
        `Your branch is now on the public fork!\n\nCreate a pull request to upstream:\n  ${prUrl}\n\n(Tip: re-run with --pr to open it automatically.)`,
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
    p.log.warn(
      `PR URL points to ${sourceRepoPath}, but the upstream remote is ${upstreamRepoPath}. Continuing under the assumption you meant ${upstreamRepoPath} (gh fetch uses the upstream remote).`
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
        `git fetch upstream ${fetchRefspec} failed. The PR's head ref may have been removed by a deleted source branch. Stderr:\n${fetchResult.stderr.trim()}`
      );
    }
    const headSha = (
      await $({ cwd: repoDir })`git rev-parse ${localBranch}`
    ).stdout.trim();
    s.stop(`Fetched ${headSha.slice(0, 9)} → ${localBranch}`);

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
        p.log.warn('The local branch is still available for review.');
      } else {
        s.stop(`Pushed ${localBranch} to origin`);
      }
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

  // Check if setup is complete
  const isSetupComplete = hasOrigin && hasPublic && hasUpstream;

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
    '',
    'Setup status:',
    `  ${hasOrigin ? '✓' : '✗'} origin (private mirror)`,
    `  ${hasPublic ? '✓' : '✗'} public (public fork)`,
    `  ${hasUpstream ? '✓' : '✗'} upstream (original repo)`,
  ];

  p.note(statusLines.join('\n'), 'Repository Status');

  // Show appropriate outro
  if (isSetupComplete) {
    p.outro('✨ Venfork is fully configured!');
  } else {
    const missingRemotes = [];
    if (!hasOrigin) missingRemotes.push('origin');
    if (!hasPublic) missingRemotes.push('public');
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
    `venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>]
  Create private mirror + public fork for vendor workflow
  <upstream>: GitHub HTTPS/SSH URL, or shorthand owner/repo (e.g. facebook/react)

  Options:
  • --org <name>       Create repos under organization instead of user account
  • --fork-name <name> Public fork repo name under owner (gh repo fork --fork-name).
                       Use when upstream is already owner/repo so the fork needs a different name.

  Creates:
  • Private mirror (yourname/project-private) - internal work
  • Public fork (yourname/project) - staging for upstream
  • Configures remotes: origin, public, upstream

venfork clone <vendor-repo>
  Clone an existing vendor setup and configure remotes automatically
  <vendor-repo>: URL or owner/repo for the private mirror

  Auto-detects:
  • Public fork (strips -private suffix)
  • Upstream repository (from public fork's parent)
  • Configures all three remotes (origin, public, upstream)

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

venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>]
  Push branch to public fork for PR to upstream
  When schedule is enabled, strips internal workflow commit before public push
  With --pr, also opens the upstream PR using the internal-review PR's body
    (with <!-- venfork:internal -->...<!-- /venfork:internal --> blocks redacted)
  This is when your work becomes visible to the client

venfork pull-request <pr-number-or-url> [--branch-name <name>] [--no-push]
  Bring a third-party upstream PR into the mirror for internal review
  Fetches pull/<n>/head from upstream into a new branch (default: upstream-pr/<n>)
  Pushes the branch to origin so the team can see it
  Refresh later with: venfork sync <branch>

venfork workflows <status|allow|block|clear> [workflow-file ...]
  Configure workflow allowlist/blocklist policy in venfork-config`,
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

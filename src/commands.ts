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
const VENFORK_BOT_NAME = 'venfork-bot';
const VENFORK_BOT_EMAIL = 'venfork-bot@users.noreply.github.com';

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
  return changedFiles.every((filePath) => filePath === SYNC_WORKFLOW_PATH);
}

/**
 * Internal workflow commit marker used by the mirror "+1 commit" model.
 *
 * We identify this commit by its deterministic message and also accept commits
 * that change only the managed workflow file, so historical repos can still
 * be normalized.
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
  cwd?: string
): Promise<void> {
  const repoDir = cwd ?? process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-sync-'));

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

async function buildPublicStageHeadWithoutWorkflowCommit(
  branch: string,
  defaultBranch: string,
  cwd?: string
): Promise<string> {
  const repoDir = cwd ?? process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-stage-'));
  try {
    await $({
      cwd: repoDir,
    })`git worktree add --detach ${tempDir} ${branch}`;
    const rebaseResult = await $({
      cwd: tempDir,
      reject: false,
    })`git rebase --onto upstream/${defaultBranch} origin/${defaultBranch}`;
    if (rebaseResult.exitCode !== 0) {
      await $({
        cwd: tempDir,
        reject: false,
      })`git rebase --abort`;
      throw new Error(
        `Failed to stage '${branch}' because removing the internal workflow commit caused rebase conflicts. Rebase '${branch}' on upstream/${defaultBranch} and retry.`
      );
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
    // Step 1: Fetch from upstream
    s.start('Fetching from upstream');
    await $(cwdOpt)`git fetch upstream`;
    await $(cwdOpt)`git fetch origin`;
    await $(cwdOpt)`git fetch public`;
    s.stop('Fetched from all remotes');

    // Step 2: Detect default branch if not specified
    const defaultBranch =
      targetBranch || (await getDefaultBranch('upstream', options?.cwd));
    const repoDir = options?.cwd ?? process.cwd();
    const config = await readVenforkConfigFromRepo(repoDir);
    const scheduleConfig = config?.schedule;

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
To force sync anyway: git push origin upstream/${defaultBranch}:${defaultBranch} -f`,
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
    )`git push origin upstream/${defaultBranch}:${defaultBranch} --force`;
    await $(
      cwdOpt
    )`git push public upstream/${defaultBranch}:${defaultBranch} --force`;

    s.stop('Synced to all remotes');

    // Step 6: Enforce mirror "+1 commit" model for scheduled sync workflow.
    // Scheduling config lives on `venfork-config`; when enabled we re-stamp
    // one deterministic workflow commit on top of upstream.
    if (scheduleConfig?.enabled && scheduleConfig.cron) {
      s.start('Re-applying scheduled sync workflow commit');
      await applyScheduledWorkflowCommit(
        defaultBranch,
        scheduleConfig.cron,
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

      p.outro(
        `✨ Scheduled sync enabled\n\nBranch: ${defaultBranch}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}`
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
 * Stage command: Push branch to public fork for PR to upstream
 */
export async function stageCommand(branch: string): Promise<void> {
  p.intro('📤 Venfork Stage');

  // Check GitHub CLI authentication
  const isAuthenticated = await checkGhAuth();
  if (!isAuthenticated) {
    throw new AuthenticationError();
  }

  if (!branch) {
    p.log.error('Branch name is required');
    p.outro('Usage: venfork stage <branch>');
    process.exit(1);
  }

  const s = p.spinner();

  try {
    // Step 1: Verify branch exists
    s.start('Verifying branch exists');
    const branchCheck = await $({
      reject: false,
    })`git rev-parse --verify ${branch}`;
    if (branchCheck.exitCode !== 0) {
      throw new BranchNotFoundError(branch);
    }
    s.stop('Branch verified');

    // Step 2: Get public fork URL
    const publicUrlResult = await $({
      reject: false,
    })`git remote get-url public`;
    if (publicUrlResult.exitCode !== 0) {
      throw new RemoteNotFoundError('public');
    }
    const publicUrl = publicUrlResult.stdout.trim();
    const publicRepoPath = parseRepoPath(publicUrl);

    // Step 3: Get upstream URL for PR link
    const upstreamUrlResult = await $({
      reject: false,
    })`git remote get-url upstream`;
    const upstreamUrl = upstreamUrlResult.stdout.trim();
    const upstreamRepoPath = parseRepoPath(upstreamUrl);

    // Step 4: Confirm stage
    p.note(
      `Branch '${branch}' will be pushed to your public fork.
This makes your work visible and ready for PR to upstream.

  From: Private vendor repo (current)
  To:   ${publicUrl}
  PR:   ${publicRepoPath} → ${upstreamRepoPath}`,
      'Staging Details'
    );

    const shouldStage = await p.confirm({
      message: 'Push to public fork?',
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

    const repoDir = process.cwd();

    // Step 5: Detect upstream default branch for staging + PR URL
    const upstreamDefaultBranch = await getDefaultBranch('upstream');
    const scheduleEnabled = await isScheduleEnabled(repoDir);

    // Step 6: If schedule is enabled, strip the internal workflow commit before
    // publishing. Otherwise keep normal direct branch push behavior.
    if (scheduleEnabled) {
      await $`git fetch upstream`;
      await $`git fetch origin`;
      s.start('Preparing sanitized branch for public staging');
      const stageHead = await buildPublicStageHeadWithoutWorkflowCommit(
        branch,
        upstreamDefaultBranch,
        repoDir
      );
      s.stop('Prepared sanitized branch');

      s.start('Pushing sanitized branch to public fork');
      if (await remoteBranchExists('public', branch)) {
        await $`git push public ${stageHead}:refs/heads/${branch} --force-with-lease=refs/heads/${branch}`;
      } else {
        await $`git push public ${stageHead}:refs/heads/${branch}`;
      }
      s.stop('Push successful');
    } else {
      s.start('Pushing to public fork');
      await $`git push public ${branch}`;
      s.stop('Push successful');
    }

    // Step 7: Show PR creation link
    const prUrl = `https://github.com/${upstreamRepoPath}/compare/${upstreamDefaultBranch}...${publicRepoPath.split('/')[0]}:${branch}?expand=1`;

    p.note(
      `Your branch is now on the public fork!\n\nCreate a pull request to upstream:\n  ${prUrl}`,
      'Next Steps'
    );

    p.outro('✨ Stage complete!');
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Stage failed');
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
  Syncs main/master branch without affecting your current work

venfork schedule <status|set <cron>|disable>
  Manage scheduled sync config stored in venfork-config
  Set writes/removes ${SYNC_WORKFLOW_PATH} on the private mirror default branch

venfork stage <branch>
  Push branch to public fork for PR to upstream
  When schedule is enabled, strips internal workflow commit before public push
  This is when your work becomes visible to the client`,
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

# After team approval, stage for upstream
venfork stage feature/new-thing
# NOW visible on public fork
# Create PR: public fork → upstream`,
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

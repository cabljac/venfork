import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { $ } from 'execa';
import { createConfigBranch, fetchVenforkConfig } from './config.js';
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
  hasRemote,
  isGitRepository,
} from './git.js';
import { parseOwner, parseRepoName, parseRepoPath } from './utils.js';

/**
 * Setup command: Create private mirror and public fork
 */
export async function setupCommand(
  upstreamUrl?: string,
  privateMirrorName?: string,
  organization?: string
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

  // Prompt for upstream URL only if not provided
  if (!finalUpstreamUrl) {
    const response = await p.text({
      message: 'Upstream repository URL?',
      placeholder: 'git@github.com:google/project.git',
      validate: (value) => {
        if (!value) return 'Repository URL is required';
        if (!value.includes('github.com')) return 'Must be a GitHub URL';
      },
    });

    if (p.isCancel(response)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    finalUpstreamUrl = response as string;
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
    // Step 1: Create public fork
    s.start('Creating public fork of upstream repository');
    const upstreamRepoPath = parseRepoPath(config.upstreamUrl);
    if (organization) {
      await $`gh repo fork ${upstreamRepoPath} --clone=false --org ${organization}`;
    } else {
      await $`gh repo fork ${upstreamRepoPath} --clone=false`;
    }
    s.stop('Public fork created');

    // Get the public fork name (same as upstream repo name)
    const publicForkName = parseRepoName(config.upstreamUrl);

    // Step 2: Create private mirror repository
    s.start('Creating private mirror repository');
    const privateMirrorRepoName = organization
      ? `${organization}/${config.privateMirrorName}`
      : config.privateMirrorName;
    await $`gh repo create ${privateMirrorRepoName} --private --clone=false`;
    s.stop('Private mirror repository created');

    // Step 3: Clone upstream to temp directory
    s.start('Cloning upstream repository');
    await $`git clone --bare ${config.upstreamUrl} ${tempDir}`;
    s.stop('Upstream cloned');

    // Step 4: Push to private mirror repo
    s.start('Pushing to private mirror repository');
    await $({
      cwd: tempDir,
    })`git push --mirror git@github.com:${owner}/${config.privateMirrorName}.git`;
    s.stop('Pushed to private mirror repository');

    // Step 5: Clone private mirror repo locally
    s.start('Cloning private mirror repository locally');
    await $`git clone git@github.com:${owner}/${config.privateMirrorName}.git`;
    s.stop('Private mirror repository cloned');

    // Step 6: Configure remotes
    s.start('Configuring git remotes');
    const repoDir = config.privateMirrorName;

    // Add public fork remote
    await $({
      cwd: repoDir,
    })`git remote add public git@github.com:${owner}/${publicForkName}.git`;

    // Add upstream remote (with push disabled)
    await $({ cwd: repoDir })`git remote add upstream ${config.upstreamUrl}`;
    await $({ cwd: repoDir })`git remote set-url --push upstream DISABLE`;

    s.stop('Git remotes configured');

    // Step 7: Create and push venfork config branch
    s.start('Creating venfork configuration');
    const publicForkUrl = `git@github.com:${owner}/${publicForkName}.git`;
    await createConfigBranch(repoDir, publicForkUrl, config.upstreamUrl);
    s.stop('Venfork configuration created');

    // Show remote configuration
    const remotesOutput = await $({ cwd: repoDir })`git remote -v`;
    const remotesText = remotesOutput.stdout;

    p.note(remotesText.trim(), 'Git Remote Configuration');

    p.note(
      `Private Mirror: https://github.com/${owner}/${config.privateMirrorName} (for internal work)
Public Fork: https://github.com/${owner}/${publicForkName} (for staging to upstream)
Upstream: ${config.upstreamUrl} (read-only)`,
      'Repositories Created'
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
  if (!vendorRepoUrl) {
    p.log.error('Vendor repository URL is required');
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
    const vendorRepoName = parseRepoName(vendorRepoUrl);
    const owner = parseOwner(vendorRepoUrl);

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

    // Step 2: Clone vendor repository
    s.start('Cloning vendor repository');
    await $`git clone ${vendorRepoUrl}`;
    s.stop('Vendor repository cloned');

    // Step 3: Try to fetch venfork config
    s.start('Fetching venfork configuration');
    const config = await fetchVenforkConfig(vendorRepoUrl);

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
export async function syncCommand(targetBranch?: string): Promise<void> {
  p.intro('🔄 Venfork Sync');

  const s = p.spinner();

  try {
    // Step 1: Fetch from upstream
    s.start('Fetching from upstream');
    await $`git fetch upstream`;
    await $`git fetch origin`;
    await $`git fetch public`;
    s.stop('Fetched from all remotes');

    // Step 2: Detect default branch if not specified
    const defaultBranch = targetBranch || (await getDefaultBranch('upstream'));

    // Step 3: Check for divergence
    s.start('Checking for divergent commits');

    const checkDivergence = async (remote: string): Promise<number> => {
      try {
        const result =
          await $`git rev-list --count upstream/${defaultBranch}..${remote}/${defaultBranch}`;
        return Number.parseInt(result.stdout.trim(), 10);
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

      p.outro('❌ Sync aborted to prevent data loss');
      process.exit(1);
    }

    // Step 5: Push upstream default branch to origin and public
    s.start(`Syncing ${defaultBranch} to origin and public`);

    await $`git push origin upstream/${defaultBranch}:${defaultBranch} --force`;
    await $`git push public upstream/${defaultBranch}:${defaultBranch} --force`;

    s.stop('Synced to all remotes');

    p.outro(
      `✨ Sync complete! origin/${defaultBranch} and public/${defaultBranch} are now up to date with upstream/${defaultBranch}`
    );
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Sync failed');
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

    // Step 5: Push to public fork
    s.start('Pushing to public fork');
    await $`git push public ${branch}`;
    s.stop('Push successful');

    // Step 6: Detect upstream default branch for PR URL
    const upstreamDefaultBranch = await getDefaultBranch('upstream');

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
      `Run venfork setup <upstream-url> to configure:\n  ${missingRemotes.join(', ')}`,
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
    `venfork setup <upstream-url> [name] [--org <organization>]
  Create private mirror + public fork for vendor workflow

  Options:
  • --org <name>  Create repos under organization instead of user account

  Creates:
  • Private mirror (yourname/project-private) - internal work
  • Public fork (yourname/project) - staging for upstream
  • Configures remotes: origin, public, upstream

venfork clone <vendor-repo-url>
  Clone an existing vendor setup and configure remotes automatically

  Auto-detects:
  • Public fork (strips -private suffix)
  • Upstream repository (from public fork's parent)
  • Configures all three remotes (origin, public, upstream)

venfork status
  Show current repository setup and configuration
  Check which remotes are configured and setup completion

venfork sync [branch]
  Update default branches of origin and public to match upstream
  Syncs main/master branch without affecting your current work

venfork stage <branch>
  Push branch to public fork for PR to upstream
  This is when your work becomes visible to the client`,
    'Available Commands'
  );

  p.note(
    `# One-time setup
venfork setup git@github.com:awesome/project.git

# Or for organization repos:
venfork setup git@github.com:awesome/project.git --org my-company

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

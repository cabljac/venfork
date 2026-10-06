import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { $ } from 'execa';
import { createConfigBranch, readVenforkConfigFromRepo } from '../config.js';
import { ConfigError } from '../errors.js';
import { getGitHubUsername, ghRepoExists, ghRepoIsForkOf } from '../git.js';
import { pathExists } from '../shared/fs.js';
import { netExec, runNetOp, seedMirrorInChunks } from '../shared/net.js';
import {
  normalizeGitHubRepoInput,
  parseRepoName,
  parseRepoPath,
} from '../utils.js';
import { syncCommand } from './sync.js';

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
 * Throws when the `venfork-config` already on origin records a different
 * layout than this setup run asks for. URLs compare by `owner/repo`.
 */
async function assertExistingConfigAgrees(
  repoDir: string,
  wanted: {
    mode: 'standard' | 'no-public';
    upstreamUrl: string;
    publicForkUrl: string | null;
  }
): Promise<void> {
  const existing = await readVenforkConfigFromRepo(repoDir);
  if (!existing) {
    throw new ConfigError(
      'venfork-config disappeared from origin while setup was running; re-run setup.',
      { reason: 'fetch' }
    );
  }
  const sameRepo = (a: string | null, b: string | null) =>
    (a ? (parseRepoPath(a) ?? a) : null) ===
    (b ? (parseRepoPath(b) ?? b) : null);
  const recordedMode = existing.mode === 'no-public' ? 'no-public' : 'standard';
  const recordedPublic = existing.publicForkUrl ?? null;
  const mismatches: string[] = [];
  if (recordedMode !== wanted.mode) {
    mismatches.push(`mode is ${recordedMode} (expected ${wanted.mode})`);
  }
  if (!sameRepo(existing.upstreamUrl, wanted.upstreamUrl)) {
    mismatches.push(
      `upstreamUrl is ${existing.upstreamUrl} (expected ${wanted.upstreamUrl})`
    );
  }
  if (!sameRepo(recordedPublic, wanted.publicForkUrl)) {
    mismatches.push(
      `publicForkUrl is ${recordedPublic ?? '(none)'} (expected ${wanted.publicForkUrl ?? '(none)'})`
    );
  }
  if (mismatches.length > 0) {
    throw new ConfigError(
      `The existing venfork-config disagrees with this setup: ${mismatches.join('; ')}. Use the recorded values, or create a fresh mirror.`,
      { reason: 'exists' }
    );
  }
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
      process.exit(130);
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
      process.exit(130);
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

    if (p.isCancel(confirmed)) {
      p.outro('❌ Setup cancelled');
      process.exit(130);
    }
    if (!confirmed) {
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
    // Transient URL used only to seed the new mirror. HTTPS + gh's git
    // credential helper keeps this consistent with the gh-based clones and
    // avoids depending on the user's SSH setup (the cause of setup hangs).
    const privateHttpsUrl = `https://github.com/${owner}/${config.privateMirrorName}.git`;
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
      await runNetOp(
        'Cloning upstream repository',
        'Upstream cloned',
        () =>
          netExec()`gh repo clone ${upstreamRepoPath} ${tempDir} -- --progress`
      );

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

      await seedMirrorInChunks(tempDir, privateHttpsUrl, defaultBranch);
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
      s.stop('Preparing local private mirror clone');
      await runNetOp(
        'Cloning private mirror repository',
        'Private mirror repository cloned',
        () =>
          netExec()`gh repo clone ${privateMirrorGhPath} ${repoDir} -- --progress`
      );
    }

    // Set gh default repository to the private mirror so `gh pr create` etc.
    // resolve to origin without prompting.
    s.start('Setting gh default repository');
    await $({ cwd: repoDir })`gh repo set-default ${privateMirrorGhPath}`;
    s.stop('Default repository set');

    // Step 7: Venfork config branch, checked before any remote is rewired
    s.start('Creating venfork configuration');
    const mode = noPublic ? 'no-public' : 'standard';
    try {
      await createConfigBranch(
        repoDir,
        noPublic ? null : (publicForkUrl ?? null),
        config.upstreamUrl,
        mode
      );
      s.stop('Venfork configuration created');
    } catch (err) {
      if (!(err instanceof ConfigError && err.reason === 'exists')) throw err;
      await assertExistingConfigAgrees(repoDir, {
        mode,
        upstreamUrl: config.upstreamUrl,
        publicForkUrl: publicForkUrl ?? null,
      });
      s.stop('Keeping the existing venfork configuration');
    }

    // Step 8: Configure remotes
    s.start('Configuring git remotes');
    await ensureVenforkRemotes(repoDir, publicForkUrl, config.upstreamUrl);
    s.stop('Git remotes configured');

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

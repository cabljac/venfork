import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { createConfigBranch, readVenforkConfigFromRepo } from '../config.js';
import {
  CommandExitError,
  ConfigError,
  GitHubError,
  PreconditionError,
} from '../errors.js';
import {
  getGitHubUsername,
  ghGitProtocol,
  ghRepoExists,
  ghRepoIsForkOf,
} from '../git.js';
import { checkSetupInputs } from '../setup-args.js';
import { pathExists } from '../shared/fs.js';
import { claimInterrupts } from '../shared/interrupt.js';
import { netExec, runNetOp, seedMirrorInChunks } from '../shared/net.js';
import {
  isCancel,
  type PromptContext,
  promptConfirm,
  promptText,
} from '../shared/prompt.js';
import * as p from '../shared/ui.js';
import {
  githubUrlForProtocol,
  normalizeGitHubRepoInput,
  parseRepoName,
  parseRepoPath,
} from '../utils.js';

async function ensureVenforkRemotes(
  cwd: string,
  publicUrl: string | undefined,
  upstreamUrl: string
): Promise<void> {
  const setOrAdd = async (name: string, fetchUrl: string) => {
    const cur = await $({ cwd, reject: false })`git remote get-url ${name}`;
    if (cur.exitCode === 0) {
      if (cur.stdout.trim() !== fetchUrl) {
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
      "The mirror's venfork settings disappeared from origin while setup was running; re-run setup.",
      { reason: 'fetch' }
    );
  }
  const sameRepo = (a: string | null, b: string | null) =>
    (a ? (parseRepoPath(a) ?? a) : null) ===
    (b ? (parseRepoPath(b) ?? b) : null);
  const recordedMode = existing.mode === 'no-public' ? 'no-public' : 'standard';
  const layout = (mode: 'standard' | 'no-public') =>
    mode === 'no-public' ? 'own-upstream' : 'standard';
  const recordedPublic = existing.publicForkUrl ?? null;
  const mismatches: string[] = [];
  if (recordedMode !== wanted.mode) {
    mismatches.push(
      `layout is ${layout(recordedMode)} (expected ${layout(wanted.mode)})`
    );
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
      `The mirror's existing venfork settings disagree with this setup: ${mismatches.join('; ')}. Use the recorded values, or create a fresh mirror.`,
      { reason: 'exists' }
    );
  }
}

/** A GitHub repository in the `--json` result of `venfork setup`. */
export interface SetupRepo {
  /** `owner/name`. */
  repo: string;
  /** Web URL, `https://github.com/<owner>/<name>`. */
  url: string;
}

/** What `venfork setup` created or reused, reported as the `--json` result. */
export interface SetupResult {
  mode: 'standard' | 'no-public';
  mirror: SetupRepo;
  /** Absent in no-public mode. */
  publicFork?: SetupRepo;
  upstream: SetupRepo;
  /** Absolute path of the local mirror checkout. */
  directory: string;
}

function setupRepo(repo: string): SetupRepo {
  return { repo, url: `https://github.com/${repo}` };
}

/**
 * Setup command: Create private mirror and public fork
 *
 * @param publicForkRepoName - Optional GitHub repo name for the public fork under `owner` (see `gh repo fork --fork-name`). Defaults to the upstream repo basename. Use when the fork must differ (e.g. same org as upstream).
 * @param options.noPublic - Skip the public-fork hop entirely. Only `origin` (private mirror) and `upstream` are configured; `stage` later pushes branches directly to `upstream`. Mutually exclusive with `publicForkRepoName`.
 * @param options.prompt - `--yes` answers the personal-account confirm; `--no-input` never prompts.
 * @param options.organizationFromEnv - `organization` came from `VENFORK_ORG`, so naming your own account there is not consent.
 * @param options.syncMirror - Quietly syncs the local clone at `cwd` when the fork or mirror already existed on GitHub.
 * @returns The repos and the local checkout, for `--json`.
 */
export async function setupCommand(
  upstreamUrl: string | undefined,
  privateMirrorName: string | undefined,
  organization: string | undefined,
  publicForkRepoName: string | undefined,
  options: {
    noPublic?: boolean;
    syncMirror: (cwd: string) => Promise<void>;
    prompt?: PromptContext;
    organizationFromEnv?: boolean;
  }
): Promise<SetupResult> {
  const noPublic = options.noPublic === true;
  checkSetupInputs({ upstreamUrl, publicForkRepoName, noPublic });
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
    const response = await promptText(
      {
        message: 'Upstream repository URL or owner/repo?',
        flag: 'the <upstream> argument',
        placeholder: 'invertase/react-native-firebase',
        validate: validateUpstreamInput,
      },
      options.prompt
    );

    if (isCancel(response)) {
      p.cancel('Operation cancelled');
      throw new CommandExitError(130);
    }

    finalUpstreamUrl = normalizeGitHubRepoInput(response);
  } else {
    finalUpstreamUrl = normalizeGitHubRepoInput(finalUpstreamUrl);
  }

  // Prompt for private mirror name only if not provided
  if (!finalPrivateMirrorName) {
    const defaultName = `${parseRepoName(finalUpstreamUrl)}-private`;
    const response = await promptText(
      {
        message: 'Private mirror repo name?',
        flag: 'the [name] argument',
        placeholder: defaultName,
        defaultValue: defaultName,
        validate: (value) => {
          if (!value) return 'Private mirror repo name is required';
          if (!/^[a-zA-Z0-9-_]+$/.test(value))
            return 'Name can only contain letters, numbers, hyphens, and underscores';
        },
      },
      options.prompt
    );

    if (isCancel(response)) {
      p.cancel('Operation cancelled');
      throw new CommandExitError(130);
    }

    finalPrivateMirrorName = response;
  }

  const config = {
    upstreamUrl: finalUpstreamUrl,
    privateMirrorName: finalPrivateMirrorName,
  };

  const upstreamRepoBaseName = parseRepoName(config.upstreamUrl);
  const forkNameFromCli = publicForkRepoName?.trim();
  const resolvedPublicForkName = forkNameFromCli || upstreamRepoBaseName;
  const useForkNameFlag = resolvedPublicForkName !== upstreamRepoBaseName;

  const s = p.spinner();
  const username = await getGitHubUsername();

  const ownAccount =
    organization !== undefined &&
    username !== '' &&
    organization.toLowerCase() === username.toLowerCase();
  // Only `--org <you>` is consent; a VENFORK_ORG value is ambient.
  const personalAccountChosen = ownAccount && !options.organizationFromEnv;
  if (ownAccount) {
    organization = undefined;
  }

  if (!organization && !personalAccountChosen) {
    p.log.warn('⚠️  No organization specified');
    p.log.info(
      `Repos will be created under your personal account (username: ${username})`
    );

    const confirmed = await promptConfirm(
      {
        message: 'Continue with personal account?',
        initialValue: false,
      },
      options.prompt
    );

    if (isCancel(confirmed)) {
      p.outro('❌ Setup cancelled');
      throw new CommandExitError(130);
    }
    if (!confirmed) {
      p.outro('❌ Setup cancelled');
      throw new CommandExitError(0);
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

  let interrupt: (reason: CommandExitError) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject;
  });
  const onSignal = (exitCode: number) => async () => {
    s.stop('Setup interrupted');
    await cleanup();
    interrupt(new CommandExitError(exitCode));
  };
  const onSigint = onSignal(130);
  const onSigterm = onSignal(143);

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const releaseInterrupts = claimInterrupts();

  const steps = async (): Promise<SetupResult> => {
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

    // Step 1: Create public fork (or accept an existing fork under this owner); skipped in --own-upstream mode
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
          throw new PreconditionError(
            `The upstream repo is already under ${owner}. Use --fork-name to give the public fork a different name, or pass --own-upstream to skip the public fork hop entirely.`
          );
        }
        const exists = await ghRepoExists(publicForkFullName);
        if (!exists) {
          throw new GitHubError(
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
          throw new PreconditionError(
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
        throw new GitHubError(
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
        throw new PreconditionError(
          `Directory '${repoDir}' already exists and is not a git repository`
        );
      }
      const originResult = await $({
        cwd: repoDir,
        reject: false,
      })`git remote get-url origin`;
      if (originResult.exitCode !== 0) {
        throw new PreconditionError(
          `Directory '${repoDir}' exists but has no origin remote configured`
        );
      }
      const existingPath = parseRepoPath(originResult.stdout.trim());
      const expectedPath = parseRepoPath(privateCloneUrl);
      if (existingPath !== expectedPath) {
        throw new PreconditionError(
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
    const protocol = await ghGitProtocol();
    const upstreamRemoteUrl = githubUrlForProtocol(
      config.upstreamUrl,
      protocol
    );
    const publicRemoteUrl =
      publicForkUrl && githubUrlForProtocol(publicForkUrl, protocol);
    try {
      await createConfigBranch(
        repoDir,
        publicRemoteUrl ?? null,
        upstreamRemoteUrl,
        mode
      );
      s.stop('Venfork configuration created');
    } catch (err) {
      if (!(err instanceof ConfigError && err.reason === 'exists')) throw err;
      await assertExistingConfigAgrees(repoDir, {
        mode,
        upstreamUrl: upstreamRemoteUrl,
        publicForkUrl: publicRemoteUrl ?? null,
      });
      s.stop('Keeping the existing venfork configuration');
    }

    // Step 8: Configure remotes
    s.start('Configuring git remotes');
    await ensureVenforkRemotes(repoDir, publicRemoteUrl, upstreamRemoteUrl);
    s.stop('Git remotes configured');

    const recovered = forkPreexisted || mirrorPreexisted;
    if (recovered) {
      p.log.info(
        'Repos already existed on GitHub; syncing default branch from upstream into this clone'
      );
      const repoAbs = path.resolve(repoDir);
      await options.syncMirror(repoAbs);
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
    return {
      mode,
      mirror: setupRepo(privateMirrorGhPath),
      ...(noPublic ? {} : { publicFork: setupRepo(publicForkFullName) }),
      upstream: setupRepo(upstreamRepoPath),
      directory: path.resolve(repoDir),
    };
  };

  try {
    return await Promise.race([interrupted, steps()]);
  } catch (error) {
    const failure = p.reportFailure(error, s);
    await cleanup();
    throw failure;
  } finally {
    // Ensure cleanup and remove signal handlers
    await cleanup();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    releaseInterrupts();
  }
}

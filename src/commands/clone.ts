import { rm } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'execa';
import { checkCloneInputs, githubRepoInput } from '../clone-args.js';
import { fetchVenforkConfig } from '../config.js';
import { CommandExitError, PreconditionError } from '../errors.js';
import { ghGitProtocol } from '../git.js';
import { netExec, runNetOp } from '../shared/net.js';
import { isCancel, type PromptContext, promptText } from '../shared/prompt.js';
import * as p from '../shared/ui.js';
import {
  githubUrlForProtocol,
  parseOwner,
  parseRepoName,
  parseRepoPath,
} from '../utils.js';

/** Removes the directory a failed or cancelled clone created, so a rerun can clone again. */
async function removePartialClone(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    p.log.info(`Removed the partial clone '${dir}'`);
  } catch (err) {
    p.log.warn(
      `Could not remove the partial clone '${dir}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** True when two remote URLs name the same repository. */
function sameRepo(a: string, b: string): boolean {
  const pathA = parseRepoPath(a).toLowerCase();
  const pathB = parseRepoPath(b).toLowerCase();
  if (pathA && pathB) return pathA === pathB;
  return a.trim() === b.trim();
}

function validatePublicFork(value: string): string | undefined {
  if (!value.trim()) return 'Public fork URL is required';
  if (!githubRepoInput(value)) {
    return 'Use a GitHub URL or owner/repo (e.g. acme/project)';
  }
  return undefined;
}

function validateUpstream(value: string): string | undefined {
  if (!value.trim()) return 'Upstream URL is required';
  if (!githubRepoInput(value)) {
    return 'Use a GitHub URL or owner/repo (e.g. client/project)';
  }
  return undefined;
}

/** What `venfork clone` set up, reported as the `--json` result. */
export interface CloneResult {
  mode: 'standard' | 'no-public';
  /** Absolute path of the new checkout. */
  directory: string;
  /** Fetch URL of each configured remote; `public` is absent in no-public mode. */
  remotes: { origin: string; public?: string; upstream: string };
}

/**
 * Clone command: Clone vendor repository and configure all remotes. A run
 * that fails or is cancelled after cloning removes the clone.
 *
 * @param options.noPublic - Legacy mirrors only: the mirror has no public fork.
 * @param options.upstreamUrl - Legacy mirrors only: upstream URL, skips detection.
 * @param options.publicForkUrl - Legacy mirrors only: public fork URL or owner/repo, skips detection.
 * @param options.prompt - `--no-input`: never prompt.
 * @returns The new checkout and its remotes, for `--json`.
 */
export async function cloneCommand(
  vendorRepoUrl?: string,
  options: {
    noPublic?: boolean;
    upstreamUrl?: string;
    publicForkUrl?: string;
    /** `--no-input`. */
    prompt?: PromptContext;
  } = {}
): Promise<CloneResult> {
  const {
    vendorCloneUrl,
    upstreamUrl: upstreamFlag,
    publicForkUrl: publicForkFlag,
  } = checkCloneInputs({
    vendorRepoUrl,
    ...options,
  });

  p.intro('🔧 Venfork Clone');

  const s = p.spinner();
  let clonedDir: string | undefined;

  try {
    // Parse vendor repo details
    const vendorRepoName = parseRepoName(vendorCloneUrl);
    const owner = parseOwner(vendorCloneUrl);

    if (!owner || !vendorRepoName) {
      throw new Error('Invalid vendor repository URL');
    }

    const dirExists = await $`test -d ${vendorRepoName}`.then(
      () => true,
      () => false
    );
    if (dirExists) {
      const error = new PreconditionError(
        `Directory '${vendorRepoName}' already exists.`
      );
      throw p.reportFailure(error);
    }

    // Step 2: Clone vendor repository (gh respects git_protocol and accepts owner/repo)
    const vendorGhPath = parseRepoPath(vendorCloneUrl);
    await runNetOp(
      'Cloning vendor repository',
      'Vendor repository cloned',
      () => netExec()`gh repo clone ${vendorGhPath} ${vendorRepoName}`
    );
    clonedDir = vendorRepoName;

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
        throw new PreconditionError(
          'Refusing to clone with --no-public: the venfork-config branch records mode=standard. To convert an existing setup, re-run `venfork setup` instead.'
        );
      }
      if (publicForkFlag && configMode === 'no-public') {
        throw new PreconditionError(
          'Refusing to clone with --public-fork: the venfork-config branch records mode=no-public.'
        );
      }
      if (
        publicForkFlag &&
        !sameRepo(publicForkFlag, config.publicForkUrl ?? '')
      ) {
        throw new PreconditionError(
          `Refusing to override venfork-config: --public-fork='${options.publicForkUrl}' but config records publicForkUrl='${config.publicForkUrl ?? '(missing)'}'.`
        );
      }
      if (upstreamFlag && !sameRepo(upstreamFlag, config.upstreamUrl)) {
        throw new PreconditionError(
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
      // No config branch (legacy mirror): flags override auto-detection.
      noPublic = options.noPublic === true;
      s.stop(
        noPublic
          ? 'No configuration found, using --no-public layout'
          : 'No configuration found, using auto-detection'
      );

      if (noPublic) {
        // No public fork to look up; only resolve upstream.
        publicForkUrl = undefined;
        if (upstreamFlag) {
          upstreamUrl = upstreamFlag;
        } else {
          const response = await promptText(
            {
              message:
                'Upstream URL? (no venfork-config branch was found, so it cannot be auto-detected)',
              flag: '--upstream <url>',
              placeholder: 'git@github.com:owner/repo.git',
              validate: validateUpstream,
            },
            options.prompt
          );
          if (isCancel(response)) {
            p.outro('❌ Clone cancelled');
            throw new CommandExitError(130);
          }
          upstreamUrl = githubRepoInput(response);
        }
      } else {
        if (publicForkFlag) {
          publicForkUrl = publicForkFlag;
          p.log.info(`Using --public-fork: ${parseRepoPath(publicForkUrl)}`);
        } else {
          publicForkUrl = await detectPublicFork(
            owner,
            vendorRepoName,
            s,
            options.prompt
          );
        }
        const publicRepoPath = parseRepoPath(publicForkUrl);

        // Upstream is the public fork's parent unless --upstream names it.
        s.start('Detecting upstream repository');

        if (upstreamFlag) {
          upstreamUrl = upstreamFlag;
          s.stop(`Using --upstream: ${parseRepoPath(upstreamUrl)}`);
        } else {
          try {
            const result = await netExec(undefined, {
              bufferOutput: true,
            })`gh repo view ${publicRepoPath} --json parent --jq .parent.url`;
            if (result.exitCode !== 0) throw new Error('No parent found');
            upstreamUrl = String(result.stdout ?? '').trim();

            if (!upstreamUrl || upstreamUrl === 'null') {
              throw new Error('No parent found');
            }

            const upstreamPath = parseRepoPath(upstreamUrl);
            s.stop(`Found upstream: ${upstreamPath}`);
          } catch {
            s.stop('Upstream not found');

            p.log.warn('⚠️  Public fork has no parent repository.');

            const response = await promptText(
              {
                message: 'Please provide the upstream URL:',
                flag: '--upstream <url>',
                placeholder: 'git@github.com:original/repo.git',
                validate: validateUpstream,
              },
              options.prompt
            );

            if (isCancel(response)) {
              p.outro('❌ Clone cancelled');
              throw new CommandExitError(130);
            }

            upstreamUrl = githubRepoInput(response);
          }
        }
      }
    }

    // Step 4: Configure remotes
    s.start('Configuring git remotes');
    const protocol = await ghGitProtocol();
    publicForkUrl =
      publicForkUrl && githubUrlForProtocol(publicForkUrl, protocol);
    upstreamUrl = githubUrlForProtocol(upstreamUrl, protocol);

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

    // Step 5: Set gh default repository to the mirror so `gh pr create` etc.
    // resolve to origin without prompting.
    s.start('Setting gh default repository');
    await $({ cwd: vendorRepoName })`gh repo set-default ${vendorGhPath}`;
    s.stop('Default repository set');

    // Step 6: Show configuration
    const originUrl = (
      await $({ cwd: vendorRepoName })`git remote get-url origin`
    ).stdout.trim();
    const remotesOutput = await $({ cwd: vendorRepoName })`git remote -v`;
    const remotesText = remotesOutput.stdout;

    p.note(remotesText.trim(), 'Git Remote Configuration');

    // Step 7: Success output
    p.outro(
      `✨ Clone complete!\n\nNext steps:
  cd ${vendorRepoName}
  venfork sync          # Sync with upstream
  git checkout -b feature-branch
  # Do your work...
  venfork stage feature-branch`
    );
    return {
      mode: noPublic ? 'no-public' : 'standard',
      directory: path.resolve(vendorRepoName),
      remotes: {
        origin: originUrl,
        ...(!noPublic && publicForkUrl ? { public: publicForkUrl } : {}),
        upstream: upstreamUrl,
      },
    };
  } catch (error) {
    if (clonedDir) await removePartialClone(clonedDir);
    throw p.reportFailure(error, s);
  }
}

/**
 * Finds the public fork of a legacy mirror: `<owner>/<name without -private>`
 * when it exists, else the answer to a prompt.
 */
async function detectPublicFork(
  owner: string,
  vendorRepoName: string,
  s: ReturnType<typeof p.spinner>,
  prompt: PromptContext | undefined
): Promise<string> {
  s.start('Detecting public fork');
  const publicRepoName = vendorRepoName.replace(/-private$/, '');

  const view = await netExec(undefined, {
    bufferOutput: true,
  })`gh repo view ${owner}/${publicRepoName}`;
  if (view.exitCode === 0) {
    s.stop(`Found public fork: ${owner}/${publicRepoName}`);
    return `git@github.com:${owner}/${publicRepoName}.git`;
  }
  s.stop('Public fork not found');

  p.log.warn('⚠️  Could not auto-detect public fork.');
  p.note(
    `Tried: ${owner}/${publicRepoName}\n\nTip: pass --public-fork <url>, or --no-public --upstream <url> if this mirror has no public fork.`,
    'Detection Failed'
  );

  const response = await promptText(
    {
      message: 'Please provide the public fork URL:',
      flag: '--public-fork <url>',
      placeholder: 'git@github.com:owner/repo.git',
      validate: validatePublicFork,
    },
    prompt
  );

  if (isCancel(response)) {
    p.outro('❌ Clone cancelled');
    throw new CommandExitError(130);
  }
  return githubRepoInput(response);
}

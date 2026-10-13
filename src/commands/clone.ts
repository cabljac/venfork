import * as p from '@clack/prompts';
import { $ } from 'execa';
import { fetchVenforkConfig } from '../config.js';
import { CommandExitError } from '../errors.js';
import { ghGitProtocol } from '../git.js';
import {
  githubUrlForProtocol,
  normalizeGitHubRepoInput,
  parseOwner,
  parseRepoName,
  parseRepoPath,
} from '../utils.js';

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
    throw new CommandExitError(1);
  }

  const vendorCloneUrl = normalizeGitHubRepoInput(vendorRepoUrl);
  if (!parseRepoPath(vendorCloneUrl)) {
    p.log.error(
      'Invalid vendor repository. Use a GitHub URL or owner/repo (e.g. invertase/project-private).'
    );
    p.outro('❌ Clone failed');
    throw new CommandExitError(1);
  }

  const s = p.spinner();

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
      p.log.error(`Directory '${vendorRepoName}' already exists.`);
      p.outro('❌ Clone failed');
      throw new CommandExitError(1);
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
            throw new CommandExitError(1);
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
            throw new CommandExitError(1);
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
              throw new CommandExitError(1);
            }

            upstreamUrl = response as string;
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
  } catch (error) {
    if (error instanceof CommandExitError) throw error;
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Clone failed');
    throw new CommandExitError(1);
  }
}

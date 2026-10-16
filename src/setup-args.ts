import { UsageError } from './errors.js';
import {
  consumeValue,
  parsePromptFlags,
  scanArgs,
  unexpectedArgument,
} from './shared/args.js';
import type { PromptContext } from './shared/prompt.js';
import { normalizeGitHubRepoInput, parseRepoPath } from './utils.js';

export type ParsedSetupArgs = {
  upstreamUrl?: string;
  privateMirrorName?: string;
  organization?: string;
  /** True when `organization` came from `VENFORK_ORG`, not `--org`. */
  organizationFromEnv?: boolean;
  publicForkRepoName?: string;
  noPublic: boolean;
  /** `--yes` / `--no-input`. */
  prompt: PromptContext;
};

const USAGE =
  'venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--no-public] [--yes] [--no-input]';

/**
 * Parse `venfork setup ...` argv after the `setup` token.
 */
export function parseSetupCliArgs(setupArgs: string[]): ParsedSetupArgs {
  let organization: string | undefined;
  let publicForkRepoName: string | undefined;
  let noPublic = false;
  const promptFlags = parsePromptFlags({ allowYes: true });

  const positional = scanArgs(setupArgs, USAGE, (a, i) => {
    if (promptFlags.onOption(a) !== undefined) return 0;
    if (a === '--org' || a.startsWith('--org=')) {
      const { value, consumed } = consumeValue('--org', setupArgs, i);
      organization = value;
      return consumed;
    }
    if (a === '--fork-name' || a.startsWith('--fork-name=')) {
      const { value, consumed } = consumeValue('--fork-name', setupArgs, i);
      publicForkRepoName = value;
      return consumed;
    }
    if (a === '--no-public') {
      noPublic = true;
      return 0;
    }
    return undefined;
  });
  if (positional.length > 2) throw unexpectedArgument(positional[2], USAGE);

  const trimmedForkName = publicForkRepoName?.trim() || undefined;
  checkSetupInputs({
    upstreamUrl: positional[0],
    publicForkRepoName: trimmedForkName,
    noPublic,
  });

  return {
    upstreamUrl: positional[0],
    privateMirrorName: positional[1],
    organization: organization ?? process.env.VENFORK_ORG,
    ...(organization === undefined && process.env.VENFORK_ORG !== undefined
      ? { organizationFromEnv: true }
      : {}),
    publicForkRepoName: trimmedForkName,
    noPublic,
    prompt: promptFlags.prompt,
  };
}

/**
 * Throws {@link UsageError} when the setup inputs are not valid in form: a
 * malformed `<upstream>` or `--fork-name`, or `--fork-name` with
 * `--no-public`.
 */
export function checkSetupInputs(inputs: {
  upstreamUrl?: string;
  publicForkRepoName?: string;
  noPublic?: boolean;
}): void {
  const forkName = inputs.publicForkRepoName?.trim();
  if (inputs.noPublic && forkName) {
    throw new UsageError(
      '--no-public cannot be combined with --fork-name: --no-public skips creating a public fork entirely.'
    );
  }
  if (
    inputs.upstreamUrl &&
    !parseRepoPath(normalizeGitHubRepoInput(inputs.upstreamUrl))
  ) {
    throw new UsageError(
      'Invalid upstream repository. Pass a GitHub URL or owner/repo.'
    );
  }
  if (forkName && !/^[a-zA-Z0-9._-]+$/.test(forkName)) {
    throw new UsageError(
      'Invalid --fork-name: use only letters, numbers, periods, hyphens, and underscores.'
    );
  }
}

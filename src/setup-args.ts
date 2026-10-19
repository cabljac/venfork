import { type ApprovalLevel, approvalWord } from './config.js';
import { UsageError } from './errors.js';
import {
  consumeValue,
  parsePromptFlags,
  renamedFlag,
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
  /** `--approval <level>` for a new mirror; absent means `two-person`. */
  approval?: ApprovalLevel;
  /** `--yes` / `--no-input`. */
  prompt: PromptContext;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

const USAGE =
  'venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--own-upstream] [--approval <level>] [--yes] [--no-input] [--json]';

/**
 * Parse `venfork setup ...` argv after the `setup` token.
 */
export function parseSetupCliArgs(setupArgs: string[]): ParsedSetupArgs {
  let organization: string | undefined;
  let publicForkRepoName: string | undefined;
  let noPublic = false;
  let approval: ApprovalLevel | undefined;
  const promptFlags = parsePromptFlags({ allowJson: true });

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
    if (a === '--no-public') throw renamedFlag(a, '--own-upstream');
    if (a === '--own-upstream') {
      noPublic = true;
      return 0;
    }
    if (a === '--approval' || a.startsWith('--approval=')) {
      const { value, consumed } = consumeValue('--approval', setupArgs, i);
      approval = approvalWord(value);
      if (approval === undefined) {
        throw new UsageError(
          `--approval must be on, two-person, reviewed or off, not '${value}'`
        );
      }
      return consumed;
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
    ...(approval ? { approval } : {}),
    prompt: promptFlags.prompt,
    json: promptFlags.json,
  };
}

/**
 * Throws {@link UsageError} when the setup inputs are not valid in form: a
 * malformed `<upstream>` or `--fork-name`, or `--fork-name` with
 * `--own-upstream`.
 */
export function checkSetupInputs(inputs: {
  upstreamUrl?: string;
  publicForkRepoName?: string;
  noPublic?: boolean;
}): void {
  const forkName = inputs.publicForkRepoName?.trim();
  if (inputs.noPublic && forkName) {
    throw new UsageError(
      '--own-upstream cannot be combined with --fork-name: --own-upstream skips creating a public fork entirely.'
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

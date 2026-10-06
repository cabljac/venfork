import { consumeValue, scanArgs, unexpectedArgument } from './shared/args.js';

export type ParsedSetupArgs = {
  upstreamUrl?: string;
  privateMirrorName?: string;
  organization?: string;
  publicForkRepoName?: string;
  noPublic: boolean;
};

const USAGE =
  'venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--no-public]';

/**
 * Parse `venfork setup ...` argv after the `setup` token.
 */
export function parseSetupCliArgs(setupArgs: string[]): ParsedSetupArgs {
  let organization: string | undefined;
  let publicForkRepoName: string | undefined;
  let noPublic = false;

  const positional = scanArgs(setupArgs, USAGE, (a, i) => {
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
  if (noPublic && trimmedForkName) {
    throw new Error(
      '--no-public cannot be combined with --fork-name: --no-public skips creating a public fork entirely.'
    );
  }

  return {
    upstreamUrl: positional[0],
    privateMirrorName: positional[1],
    organization: organization ?? process.env.VENFORK_ORG,
    publicForkRepoName: trimmedForkName,
    noPublic,
  };
}

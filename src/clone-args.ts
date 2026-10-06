import { consumeValue, scanArgs, unexpectedArgument } from './shared/args.js';

export type ParsedCloneArgs = {
  vendorRepoUrl?: string;
  noPublic: boolean;
  upstreamUrl?: string;
};

const USAGE = 'venfork clone <vendor-repo> [--no-public] [--upstream <url>]';

/**
 * Parse `venfork clone ...` argv after the `clone` token.
 *
 * `--no-public` and `--upstream` are escape hatches for **legacy mirrors**
 * that pre-date the `venfork-config` branch. When the config branch is
 * present, the layout is read from there and these flags are unnecessary
 * (and will conflict with the recorded `mode` if set inconsistently).
 */
export function parseCloneCliArgs(args: string[]): ParsedCloneArgs {
  let noPublic = false;
  let upstreamUrl: string | undefined;

  const positional = scanArgs(args, USAGE, (a, i) => {
    if (a === '--no-public') {
      noPublic = true;
      return 0;
    }
    if (a === '--upstream' || a.startsWith('--upstream=')) {
      const { value, consumed } = consumeValue('--upstream', args, i);
      upstreamUrl = value;
      return consumed;
    }
    return undefined;
  });
  if (positional.length > 1) throw unexpectedArgument(positional[1], USAGE);

  return {
    vendorRepoUrl: positional[0],
    noPublic,
    upstreamUrl: upstreamUrl?.trim() || undefined,
  };
}

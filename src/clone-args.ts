import {
  consumeValue,
  parsePromptFlags,
  scanArgs,
  unexpectedArgument,
} from './shared/args.js';
import type { PromptContext } from './shared/prompt.js';

export type ParsedCloneArgs = {
  vendorRepoUrl?: string;
  noPublic: boolean;
  upstreamUrl?: string;
  publicForkUrl?: string;
  /** `--no-input`; clone has no confirm, so `yes` is always false. */
  prompt: PromptContext;
};

const USAGE =
  'venfork clone <vendor-repo> [--no-public] [--upstream <url>] [--public-fork <url>] [--no-input]';

/**
 * Parse `venfork clone ...` argv after the `clone` token.
 *
 * `--no-public`, `--upstream` and `--public-fork` are escape hatches for **legacy mirrors**
 * that pre-date the `venfork-config` branch. When the config branch is
 * present, the layout is read from there and these flags are unnecessary
 * (clone refuses any that contradict the recorded layout).
 */
export function parseCloneCliArgs(args: string[]): ParsedCloneArgs {
  let noPublic = false;
  let upstreamUrl: string | undefined;
  let publicForkUrl: string | undefined;
  const promptFlags = parsePromptFlags({ allowYes: false });

  const positional = scanArgs(args, USAGE, (a, i) => {
    if (promptFlags.onOption(a) !== undefined) return 0;
    if (a === '--no-public') {
      noPublic = true;
      return 0;
    }
    if (a === '--upstream' || a.startsWith('--upstream=')) {
      const { value, consumed } = consumeValue('--upstream', args, i);
      upstreamUrl = value;
      return consumed;
    }
    if (a === '--public-fork' || a.startsWith('--public-fork=')) {
      const { value, consumed } = consumeValue('--public-fork', args, i);
      publicForkUrl = value;
      return consumed;
    }
    return undefined;
  });
  if (positional.length > 1) throw unexpectedArgument(positional[1], USAGE);

  return {
    vendorRepoUrl: positional[0],
    noPublic,
    upstreamUrl: upstreamUrl?.trim() || undefined,
    publicForkUrl: publicForkUrl?.trim() || undefined,
    prompt: promptFlags.prompt,
  };
}

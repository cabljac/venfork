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
  /** `--no-input`; clone has no confirm, so `yes` is always false. */
  prompt: PromptContext;
};

const USAGE =
  'venfork clone <vendor-repo> [--no-public] [--upstream <url>] [--no-input]';

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
    return undefined;
  });
  if (positional.length > 1) throw unexpectedArgument(positional[1], USAGE);

  return {
    vendorRepoUrl: positional[0],
    noPublic,
    upstreamUrl: upstreamUrl?.trim() || undefined,
    prompt: promptFlags.prompt,
  };
}

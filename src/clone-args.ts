import { UsageError } from './errors.js';
import {
  consumeValue,
  parsePromptFlags,
  scanArgs,
  unexpectedArgument,
} from './shared/args.js';
import type { PromptContext } from './shared/prompt.js';
import { normalizeGitHubRepoInput, parseRepoPath } from './utils.js';

export type ParsedCloneArgs = {
  vendorRepoUrl?: string;
  noPublic: boolean;
  upstreamUrl?: string;
  publicForkUrl?: string;
  /** `--no-input`; clone has no confirm, so `yes` is always false. */
  prompt: PromptContext;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

/** Usage line for `venfork clone`. */
export const CLONE_USAGE =
  'venfork clone <vendor-repo> [--no-public] [--upstream <url>] [--public-fork <url>] [--no-input] [--json]';

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
  const promptFlags = parsePromptFlags({ allowYes: false, allowJson: true });

  const positional = scanArgs(args, CLONE_USAGE, (a, i) => {
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
  if (positional.length > 1)
    throw unexpectedArgument(positional[1], CLONE_USAGE);

  const parsed = {
    vendorRepoUrl: positional[0],
    noPublic,
    upstreamUrl: upstreamUrl?.trim() || undefined,
    publicForkUrl: publicForkUrl?.trim() || undefined,
    prompt: promptFlags.prompt,
    json: promptFlags.json,
  };
  checkCloneInputs(parsed);
  return parsed;
}

/** Canonical URL of a GitHub repo given as a URL or owner/repo, or ''. */
export function githubRepoInput(value: string): string {
  const url = normalizeGitHubRepoInput(value);
  return parseRepoPath(url) ? url : '';
}

/**
 * The canonical vendor repo, `--upstream` and `--public-fork` URLs. Throws
 * {@link UsageError} when the inputs are not valid in form: a missing or
 * malformed vendor repo, a malformed `--upstream` or `--public-fork`, or
 * `--public-fork` with `--no-public`.
 */
export function checkCloneInputs(inputs: {
  vendorRepoUrl?: string;
  noPublic?: boolean;
  upstreamUrl?: string;
  publicForkUrl?: string;
}): { vendorCloneUrl: string; upstreamUrl?: string; publicForkUrl?: string } {
  if (!inputs.vendorRepoUrl?.trim()) {
    throw new UsageError(`Missing vendor repository. Usage: ${CLONE_USAGE}`);
  }
  const vendorCloneUrl = githubRepoInput(inputs.vendorRepoUrl);
  if (!vendorCloneUrl) {
    throw new UsageError(
      'Invalid vendor repository. Use a GitHub URL or owner/repo (e.g. invertase/project-private).'
    );
  }
  if (inputs.noPublic && inputs.publicForkUrl) {
    throw new UsageError(
      '--public-fork cannot be combined with --no-public: --no-public means the mirror has no public fork.'
    );
  }
  const upstreamUrl = inputs.upstreamUrl
    ? githubRepoInput(inputs.upstreamUrl)
    : undefined;
  if (upstreamUrl === '') {
    throw new UsageError(
      'Invalid --upstream. Use a GitHub URL or owner/repo (e.g. client/project).'
    );
  }
  if (!inputs.publicForkUrl) return { vendorCloneUrl, upstreamUrl };
  const publicForkUrl = githubRepoInput(inputs.publicForkUrl);
  if (!publicForkUrl) {
    throw new UsageError(
      'Invalid --public-fork. Use a GitHub URL or owner/repo (e.g. acme/project).'
    );
  }
  return { vendorCloneUrl, upstreamUrl, publicForkUrl };
}

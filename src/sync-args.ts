import { UsageError } from './errors.js';
import { isLiteralBranchName } from './shared/branch-name.js';
import { consumeValue, isPromptFlag, scanArgs } from './shared/args.js';
import { JSON_FLAG } from './shared/json-output.js';
import type { AcceptedRewrite } from './shared/tracked-branches.js';

/** Parsed `venfork sync` arguments. */
export type ParsedSyncArgs = {
  /** Open/close the `venfork-sync-blocked` issue on the mirror. */
  reportIssues: boolean;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
  /** Rewrites of tracked branches the caller accepts, at most one per branch. */
  acceptRewrites: AcceptedRewrite[];
};

/** Usage line for `venfork sync`. */
export const SYNC_USAGE =
  'venfork sync [--report-issues] [--accept-rewrite <branch>=<old>..<new>] [--yes] [--no-input] [--json]';

const ACCEPT_REWRITE = '--accept-rewrite';
const FULL_SHA = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const ACCEPT_REWRITE_VALUE = new RegExp(
  `^([^=\\s]+)=(${FULL_SHA})\\.\\.(${FULL_SHA})$`
);

/**
 * Parses one `--accept-rewrite` value, `<branch>=<old>..<new>` with full
 * commit ids. Throws a `UsageError` for any other shape.
 */
export function parseAcceptRewrite(value: string): AcceptedRewrite {
  const match = ACCEPT_REWRITE_VALUE.exec(value);
  if (!match) {
    throw new UsageError(
      `${ACCEPT_REWRITE} takes <branch>=<old>..<new> with full lowercase commit ids ('${value}'). Usage: ${SYNC_USAGE}`
    );
  }
  if (!isLiteralBranchName(match[1])) {
    throw new UsageError(`${ACCEPT_REWRITE} requires a literal branch name`);
  }
  return { branch: match[1], from: match[2], to: match[3] };
}

/**
 * Parse `venfork sync [--report-issues] [--accept-rewrite ...] [--json]
 * [--no-input]` argv after the `sync` token. `--` ends options. Throws a
 * `UsageError`, also for any positional: sync always syncs upstream's
 * default branch (and the configured tracked branches).
 */
export function parseSyncCliArgs(args: string[]): ParsedSyncArgs {
  let reportIssues = false;
  let json = false;
  const acceptRewrites: AcceptedRewrite[] = [];
  const positional = scanArgs(args, SYNC_USAGE, (arg, i) => {
    if (isPromptFlag(arg)) return 0;
    if (arg === JSON_FLAG) {
      json = true;
      return 0;
    }
    if (arg === ACCEPT_REWRITE || arg.startsWith(`${ACCEPT_REWRITE}=`)) {
      const { value, consumed } = consumeValue(ACCEPT_REWRITE, args, i);
      const rewrite = parseAcceptRewrite(value);
      if (acceptRewrites.some((r) => r.branch === rewrite.branch)) {
        throw new UsageError(
          `${ACCEPT_REWRITE} names '${rewrite.branch}' twice. Usage: ${SYNC_USAGE}`
        );
      }
      acceptRewrites.push(rewrite);
      return consumed;
    }
    if (arg !== '--report-issues') return undefined;
    reportIssues = true;
    return 0;
  });
  if (positional.length > 0) {
    throw syncBranchArgumentError(positional[0]);
  }
  return { reportIssues, json, acceptRewrites };
}

/** The usage error for `venfork sync <branch>`, pointing at `pull pr`. */
function syncBranchArgumentError(arg: string): UsageError {
  const prNumber = /^upstream-pr\/(\d+)$/.exec(arg)?.[1] ?? '<n>';
  return new UsageError(
    `venfork sync takes no branch ('${arg}'): it always syncs upstream's default branch. To refresh a pulled upstream PR, run \`venfork pull pr ${prNumber}\` again. Usage: ${SYNC_USAGE}`
  );
}

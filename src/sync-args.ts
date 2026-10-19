import { UsageError } from './errors.js';
import { isPromptFlag, scanArgs } from './shared/args.js';
import { JSON_FLAG } from './shared/json-output.js';

/** Parsed `venfork sync` arguments. */
export type ParsedSyncArgs = {
  /** Open/close the `venfork-sync-blocked` issue on the mirror. */
  reportIssues: boolean;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

/** Usage line for `venfork sync`. */
export const SYNC_USAGE =
  'venfork sync [--report-issues] [--no-input] [--json]';

/**
 * Parse `venfork sync [--report-issues] [--json] [--no-input]` argv after
 * the `sync` token. `--` ends options. Throws a `UsageError`, also for any
 * positional: sync always syncs upstream's default branch.
 */
export function parseSyncCliArgs(args: string[]): ParsedSyncArgs {
  let reportIssues = false;
  let json = false;
  const positional = scanArgs(args, SYNC_USAGE, (arg) => {
    if (isPromptFlag(arg)) return 0;
    if (arg === JSON_FLAG) {
      json = true;
      return 0;
    }
    if (arg !== '--report-issues') return undefined;
    reportIssues = true;
    return 0;
  });
  if (positional.length > 0) {
    throw syncBranchArgumentError(positional[0]);
  }
  return { reportIssues, json };
}

/** The usage error for `venfork sync <branch>`, pointing at `pull pr`. */
function syncBranchArgumentError(arg: string): UsageError {
  const prNumber = /^upstream-pr\/(\d+)$/.exec(arg)?.[1] ?? '<n>';
  return new UsageError(
    `venfork sync takes no branch ('${arg}'): it always syncs upstream's default branch. To refresh a pulled upstream PR, run \`venfork pull pr ${prNumber}\` again. Usage: ${SYNC_USAGE}`
  );
}

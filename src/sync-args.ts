import { NO_INPUT_FLAG, scanArgs, unexpectedArgument } from './shared/args.js';

/** Parsed `venfork sync` arguments. */
export type ParsedSyncArgs = {
  branch?: string;
  /** Open/close the `venfork-sync-blocked` issue on the mirror. */
  reportIssues: boolean;
};

const USAGE = 'venfork sync [branch] [--report-issues]';

/**
 * Parse `venfork sync [branch] [--report-issues] [--no-input]` argv after
 * the `sync` token. `--` ends options. Throws a `UsageError`.
 */
export function parseSyncCliArgs(args: string[]): ParsedSyncArgs {
  let reportIssues = false;
  const positional = scanArgs(args, USAGE, (arg) => {
    if (arg === NO_INPUT_FLAG) return 0;
    if (arg !== '--report-issues') return undefined;
    reportIssues = true;
    return 0;
  });
  if (positional.length > 1) {
    throw unexpectedArgument(positional[1], USAGE);
  }
  return { branch: positional[0], reportIssues };
}

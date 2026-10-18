import { NO_INPUT_FLAG, scanArgs, unexpectedArgument } from './shared/args.js';
import { JSON_FLAG } from './shared/json-output.js';

/** Parsed `venfork sync` arguments. */
export type ParsedSyncArgs = {
  branch?: string;
  /** Open/close the `venfork-sync-blocked` issue on the mirror. */
  reportIssues: boolean;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

/** Usage line for `venfork sync`. */
export const SYNC_USAGE =
  'venfork sync [branch] [--report-issues] [--no-input] [--json]';

/**
 * Parse `venfork sync [branch] [--report-issues] [--json] [--no-input]` argv
 * after the `sync` token. `--` ends options. Throws a `UsageError`.
 */
export function parseSyncCliArgs(args: string[]): ParsedSyncArgs {
  let reportIssues = false;
  let json = false;
  const positional = scanArgs(args, SYNC_USAGE, (arg) => {
    if (arg === NO_INPUT_FLAG) return 0;
    if (arg === JSON_FLAG) {
      json = true;
      return 0;
    }
    if (arg !== '--report-issues') return undefined;
    reportIssues = true;
    return 0;
  });
  if (positional.length > 1) {
    throw unexpectedArgument(positional[1], SYNC_USAGE);
  }
  return { branch: positional[0], reportIssues, json };
}

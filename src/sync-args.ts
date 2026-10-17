import { NO_INPUT_FLAG } from './shared/args.js';

/** Parsed `venfork sync` arguments. */
export type ParsedSyncArgs = {
  branch?: string;
  /** Open/close the `venfork-sync-blocked` issue on the mirror. */
  reportIssues: boolean;
};

/**
 * Parse `venfork sync [branch] [--report-issues] [--no-input]` argv after the `sync` token.
 */
export function parseSyncCliArgs(args: string[]): ParsedSyncArgs {
  let branch: string | undefined;
  let reportIssues = false;
  for (const arg of args) {
    if (arg === '--report-issues') {
      reportIssues = true;
    } else if (arg === NO_INPUT_FLAG) {
      // Accepted on every command; sync never prompts.
    } else if (arg.startsWith('-')) {
      throw new Error(
        `Unknown option '${arg}'. Usage: venfork sync [branch] [--report-issues]`
      );
    } else if (branch === undefined) {
      branch = arg;
    } else {
      throw new Error('Usage: venfork sync [branch] [--report-issues]');
    }
  }
  return { branch, reportIssues };
}

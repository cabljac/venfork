import { UsageError } from './errors.js';
import {
  consumeValue,
  parseGitHubRef,
  parsePromptFlags,
  scanArgs,
  unexpectedArgument,
  unknownOption,
} from './shared/args.js';
import type { PromptContext } from './shared/prompt.js';

/** Parsed `venfork pull pr ...` arguments. */
export type ParsedPullPrArgs = {
  kind: 'pr';
  /** PR number or URL. */
  ref: string;
  branchName?: string;
  push: boolean;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

/** Parsed `venfork pull issue ...` arguments. */
export type ParsedPullIssueArgs = {
  kind: 'issue';
  /** Issue number or URL. */
  ref: string;
  title?: string;
  /** `--yes` / `--no-input`. */
  prompt: PromptContext;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

export type ParsedPullArgs = ParsedPullPrArgs | ParsedPullIssueArgs;

const PULL_USAGE = 'venfork pull <pr|issue> <number-or-url>';
/** Usage line for `venfork pull pr`. */
export const PULL_PR_USAGE =
  'venfork pull pr <pr-number-or-url> [--branch-name <name>] [--no-push] [--no-input] [--json]';
/** Usage line for `venfork pull issue`. */
export const PULL_ISSUE_USAGE =
  'venfork pull issue <number-or-url> [--title <text>] [--yes] [--no-input] [--json]';

/**
 * Parse `venfork pull ...` argv after the `pull` token.
 * Layout: `venfork pull pr <n-or-url> [--branch-name <b>] [--no-push]` or
 * `venfork pull issue <n-or-url> [--title <t>]`, each with `--json`. Flags
 * may appear anywhere.
 */
export function parsePullCliArgs(args: string[]): ParsedPullArgs {
  let branchName: string | undefined;
  let title: string | undefined;
  let noPush: string | undefined;
  let branchNameFlag: string | undefined;
  let titleFlag: string | undefined;
  const promptFlags = parsePromptFlags({ allowJson: true });

  const targetUsage = args.includes('pr')
    ? PULL_PR_USAGE
    : args.includes('issue')
      ? PULL_ISSUE_USAGE
      : PULL_USAGE;
  const [sub, ...rest] = scanArgs(args, targetUsage, (a, i) => {
    if (promptFlags.onOption(a) !== undefined) return 0;
    if (a === '--no-push') {
      noPush = a;
      return 0;
    }
    if (a === '--branch-name' || a.startsWith('--branch-name=')) {
      const { value, consumed } = consumeValue('--branch-name', args, i);
      branchName = value;
      branchNameFlag = a;
      return consumed;
    }
    if (a === '--title' || a.startsWith('--title=')) {
      const { value, consumed } = consumeValue('--title', args, i);
      title = value;
      titleFlag = a;
      return consumed;
    }
    return undefined;
  });

  if (sub === 'pr') {
    if (titleFlag) throw unknownOption(titleFlag, PULL_PR_USAGE);
    if (rest.length > 1) throw unexpectedArgument(rest[1], PULL_PR_USAGE);
    if (rest.length === 0) {
      throw new UsageError(`Missing PR number or URL. Usage: ${PULL_PR_USAGE}`);
    }
    parseGitHubRef(rest[0], 'pull');
    return {
      kind: 'pr',
      ref: rest[0],
      branchName,
      push: noPush === undefined,
      json: promptFlags.json,
    };
  }
  if (sub === 'issue') {
    const stray = noPush ?? branchNameFlag;
    if (stray) throw unknownOption(stray, PULL_ISSUE_USAGE);
    if (rest.length > 1) throw unexpectedArgument(rest[1], PULL_ISSUE_USAGE);
    if (rest.length === 0) {
      throw new UsageError(
        `Missing issue number or URL. Usage: ${PULL_ISSUE_USAGE}`
      );
    }
    parseGitHubRef(rest[0], 'issues');
    return {
      kind: 'issue',
      ref: rest[0],
      title,
      prompt: promptFlags.prompt,
      json: promptFlags.json,
    };
  }
  if (sub === undefined) {
    throw new UsageError(`Missing pull target. Usage: ${PULL_USAGE}`);
  }
  throw new UsageError(
    `Unknown pull target: ${sub}. Expected one of: pr, issue.`
  );
}

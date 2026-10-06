import {
  consumeValue,
  scanArgs,
  unexpectedArgument,
  unknownOption,
} from './shared/args.js';

/** Parsed `venfork pull pr ...` arguments. */
export type ParsedPullPrArgs = {
  kind: 'pr';
  /** PR number or URL. */
  ref?: string;
  branchName?: string;
  push: boolean;
};

/** Parsed `venfork pull issue ...` arguments. */
export type ParsedPullIssueArgs = {
  kind: 'issue';
  /** Issue number or URL. */
  ref?: string;
  title?: string;
};

export type ParsedPullArgs = ParsedPullPrArgs | ParsedPullIssueArgs;

const PULL_USAGE = 'venfork pull <pr|issue> <number-or-url>';
const PR_USAGE =
  'venfork pull pr <pr-number-or-url> [--branch-name <name>] [--no-push]';
const ISSUE_USAGE = 'venfork pull issue <number-or-url> [--title <text>]';

/**
 * Parse `venfork pull ...` argv after the `pull` token.
 * Layout: `venfork pull pr <n-or-url> [--branch-name <b>] [--no-push]` or
 * `venfork pull issue <n-or-url> [--title <t>]`. Flags may appear anywhere.
 */
export function parsePullCliArgs(args: string[]): ParsedPullArgs {
  let branchName: string | undefined;
  let title: string | undefined;
  let noPush: string | undefined;
  let branchNameFlag: string | undefined;
  let titleFlag: string | undefined;

  const targetUsage = args.includes('pr')
    ? PR_USAGE
    : args.includes('issue')
      ? ISSUE_USAGE
      : PULL_USAGE;
  const [sub, ...rest] = scanArgs(args, targetUsage, (a, i) => {
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
    if (titleFlag) throw unknownOption(titleFlag, PR_USAGE);
    if (rest.length > 1) throw unexpectedArgument(rest[1], PR_USAGE);
    return { kind: 'pr', ref: rest[0], branchName, push: noPush === undefined };
  }
  if (sub === 'issue') {
    const stray = noPush ?? branchNameFlag;
    if (stray) throw unknownOption(stray, ISSUE_USAGE);
    if (rest.length > 1) throw unexpectedArgument(rest[1], ISSUE_USAGE);
    return { kind: 'issue', ref: rest[0], title };
  }
  if (sub === undefined) {
    throw new Error(`Missing pull target. Usage: ${PULL_USAGE}`);
  }
  throw new Error(`Unknown pull target: ${sub}. Expected one of: pr, issue.`);
}

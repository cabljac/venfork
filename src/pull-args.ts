import { consumeValue } from './shared/args.js';

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

/**
 * Parse `venfork pull ...` argv after the `pull` token.
 * Layout: `venfork pull pr <n-or-url> [--branch-name <b>] [--no-push]` or
 * `venfork pull issue <n-or-url> [--title <t>]`.
 */
export function parsePullCliArgs(args: string[]): ParsedPullArgs {
  const [sub, ...rest] = args;
  if (sub === 'pr') return parsePullPr(rest);
  if (sub === 'issue') return parsePullIssue(rest);
  if (sub === undefined || sub.startsWith('-')) {
    throw new Error(
      'Missing pull target. Usage: venfork pull <pr|issue> <number-or-url>'
    );
  }
  throw new Error(`Unknown pull target: ${sub}. Expected one of: pr, issue.`);
}

function parsePullPr(args: string[]): ParsedPullPrArgs {
  const positional: string[] = [];
  let branchName: string | undefined;
  let push = true;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-push') {
      push = false;
      continue;
    }
    if (a === '--branch-name' || a.startsWith('--branch-name=')) {
      const { value, consumed } = consumeValue('--branch-name', args, i);
      branchName = value;
      i += consumed;
      continue;
    }
    positional.push(a);
  }

  return { kind: 'pr', ref: positional[0], branchName, push };
}

function parsePullIssue(args: string[]): ParsedPullIssueArgs {
  const positional: string[] = [];
  let title: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--title' || a.startsWith('--title=')) {
      const { value, consumed } = consumeValue('--title', args, i);
      title = value;
      i += consumed;
      continue;
    }
    positional.push(a);
  }

  return { kind: 'issue', ref: positional[0], title };
}

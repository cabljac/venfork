export type IssueAction = 'stage' | 'pull';

export type ParsedIssueArgs = {
  action?: IssueAction;
  /** Issue number or URL, depending on action. */
  target?: string;
  /** Override issue title (optional). */
  title?: string;
};

function consumeValue(
  flag: string,
  args: string[],
  i: number
): { value: string; consumed: number } {
  const equalsForm = `${flag}=`;
  const a = args[i];
  if (a === flag) {
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return { value: v, consumed: 1 };
  }
  if (a.startsWith(equalsForm)) {
    const v = a.slice(equalsForm.length);
    if (!v) throw new Error(`${flag} requires a value`);
    return { value: v, consumed: 0 };
  }
  throw new Error(`internal: consumeValue called for non-matching arg ${a}`);
}

/**
 * Parse `venfork issue ...` argv after the `issue` token.
 * Layout: `venfork issue <stage|pull> <number-or-url> [--title <text>]`
 */
export function parseIssueCliArgs(issueArgs: string[]): ParsedIssueArgs {
  const positional: string[] = [];
  let title: string | undefined;

  for (let i = 0; i < issueArgs.length; i++) {
    const a = issueArgs[i];
    if (a === '--title' || a.startsWith('--title=')) {
      const { value, consumed } = consumeValue('--title', issueArgs, i);
      title = value;
      i += consumed;
      continue;
    }
    positional.push(a);
  }

  const rawAction = positional[0];
  let action: IssueAction | undefined;
  if (rawAction === 'stage' || rawAction === 'pull') {
    action = rawAction;
  } else if (rawAction !== undefined) {
    throw new Error(
      `Unknown issue action: ${rawAction}. Expected one of: stage, pull.`
    );
  }

  return {
    action,
    target: positional[1],
    title,
  };
}

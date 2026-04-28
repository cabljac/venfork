export type ParsedPullRequestArgs = {
  pr?: string;
  branchName?: string;
  push: boolean;
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
 * Parse `venfork pull-request ...` argv after the command token.
 */
export function parsePullRequestCliArgs(
  prArgs: string[]
): ParsedPullRequestArgs {
  const positional: string[] = [];
  let branchName: string | undefined;
  let push = true;

  for (let i = 0; i < prArgs.length; i++) {
    const a = prArgs[i];
    if (a === '--no-push') {
      push = false;
      continue;
    }
    if (a === '--branch-name' || a.startsWith('--branch-name=')) {
      const { value, consumed } = consumeValue('--branch-name', prArgs, i);
      branchName = value;
      i += consumed;
      continue;
    }
    positional.push(a);
  }

  return {
    pr: positional[0],
    branchName,
    push,
  };
}

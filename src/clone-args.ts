export type ParsedCloneArgs = {
  vendorRepoUrl?: string;
  noPublic: boolean;
  upstreamUrl?: string;
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
 * Parse `venfork clone ...` argv after the `clone` token.
 *
 * `--no-public` and `--upstream` are escape hatches for **legacy mirrors**
 * that pre-date the `venfork-config` branch. When the config branch is
 * present, the layout is read from there and these flags are unnecessary
 * (and will conflict with the recorded `mode` if set inconsistently).
 */
export function parseCloneCliArgs(args: string[]): ParsedCloneArgs {
  const positional: string[] = [];
  let noPublic = false;
  let upstreamUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-public') {
      noPublic = true;
      continue;
    }
    if (a === '--upstream' || a.startsWith('--upstream=')) {
      const { value, consumed } = consumeValue('--upstream', args, i);
      upstreamUrl = value;
      i += consumed;
      continue;
    }
    positional.push(a);
  }

  return {
    vendorRepoUrl: positional[0],
    noPublic,
    upstreamUrl: upstreamUrl?.trim() || undefined,
  };
}

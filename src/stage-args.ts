export type ParsedStageArgs = {
  branch?: string;
  /** When true, also open an upstream PR after staging. */
  createPr: boolean;
  /** When true, the upstream PR is opened as a draft. Implies --pr. */
  draft: boolean;
  /** Override the upstream PR title; default is the internal PR title. */
  title?: string;
  /** Override the upstream base branch; default is upstream's default branch. */
  base?: string;
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
 * Parse `venfork stage ...` argv after the `stage` token.
 */
export function parseStageCliArgs(stageArgs: string[]): ParsedStageArgs {
  const positional: string[] = [];
  let createPr = false;
  let draft = false;
  let title: string | undefined;
  let base: string | undefined;

  for (let i = 0; i < stageArgs.length; i++) {
    const a = stageArgs[i];
    if (a === '--pr') {
      createPr = true;
      continue;
    }
    if (a === '--draft') {
      draft = true;
      createPr = true;
      continue;
    }
    if (a === '--title' || a.startsWith('--title=')) {
      const { value, consumed } = consumeValue('--title', stageArgs, i);
      title = value;
      i += consumed;
      continue;
    }
    if (a === '--base' || a.startsWith('--base=')) {
      const { value, consumed } = consumeValue('--base', stageArgs, i);
      base = value;
      i += consumed;
      continue;
    }
    positional.push(a);
  }

  return {
    branch: positional[0],
    createPr,
    draft,
    title,
    base,
  };
}

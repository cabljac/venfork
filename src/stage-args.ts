export type ParsedStageArgs = {
  branch?: string;
  createPr: boolean;
  copyPrBody: boolean;
};

/**
 * Parse `venfork stage ...` argv after the `stage` token.
 */
export function parseStageCliArgs(stageArgs: string[]): ParsedStageArgs {
  const positional: string[] = [];
  let createPr = false;
  let copyPrBody = false;

  for (const arg of stageArgs) {
    if (arg === '--create-pr') {
      createPr = true;
      continue;
    }
    if (arg === '--copy-pr-body') {
      copyPrBody = true;
      continue;
    }
    positional.push(arg);
  }

  if (copyPrBody && !createPr) {
    throw new Error('--copy-pr-body requires --create-pr');
  }

  return {
    branch: positional[0],
    createPr,
    copyPrBody,
  };
}

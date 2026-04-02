export type ParsedWorkflowsArgs = {
  action: 'status' | 'allow' | 'clear';
  workflows: string[];
};

/**
 * Parse `venfork workflows ...` argv after the `workflows` token.
 */
export function parseWorkflowsCliArgs(
  workflowsArgs: string[]
): ParsedWorkflowsArgs {
  const actionRaw = workflowsArgs[0] ?? 'status';

  if (actionRaw === 'status') {
    return { action: 'status', workflows: [] };
  }

  if (actionRaw === 'clear') {
    return { action: 'clear', workflows: [] };
  }

  if (actionRaw === 'allow') {
    const values = workflowsArgs.slice(1).flatMap((entry) =>
      entry
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    );
    if (values.length === 0) {
      throw new Error(
        'Usage: venfork workflows allow <workflow-file> [more-workflow-files]'
      );
    }
    return { action: 'allow', workflows: values };
  }

  throw new Error(
    'Usage: venfork workflows <status|allow|clear> [workflow-file ...]'
  );
}

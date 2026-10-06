import { scanArgs, unexpectedArgument } from './shared/args.js';

export type ParsedWorkflowsArgs = {
  action: 'status' | 'allow' | 'block' | 'clear';
  workflows: string[];
};

const USAGE =
  'venfork workflows <status|allow|block|clear> [workflow-file ...]';

/**
 * Parse `venfork workflows ...` argv after the `workflows` token.
 */
export function parseWorkflowsCliArgs(
  workflowsArgs: string[]
): ParsedWorkflowsArgs {
  const [actionRaw = 'status', ...rest] = scanArgs(
    workflowsArgs,
    USAGE,
    () => undefined
  );

  if (actionRaw === 'status' || actionRaw === 'clear') {
    if (rest.length > 0) throw unexpectedArgument(rest[0], USAGE);
    return { action: actionRaw, workflows: [] };
  }

  if (actionRaw === 'allow' || actionRaw === 'block') {
    const values = rest.flatMap((entry) =>
      entry
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    );
    if (values.length === 0) {
      throw new Error(
        `Usage: venfork workflows ${actionRaw} <workflow-file> [more-workflow-files]`
      );
    }
    return { action: actionRaw, workflows: values };
  }

  throw new Error(`Usage: ${USAGE}`);
}

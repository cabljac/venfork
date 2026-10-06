import { scanArgs, unexpectedArgument } from './shared/args.js';

/** A `venfork workflows` action. */
export type WorkflowsAction =
  | 'status'
  | 'allow'
  | 'block'
  | 'unallow'
  | 'unblock'
  | 'clear';

export type ParsedWorkflowsArgs = {
  action: WorkflowsAction;
  workflows: string[];
};

const USAGE =
  'venfork workflows <status|allow|block|unallow|unblock|clear> [workflow-file ...]';

const LIST_ACTIONS: readonly WorkflowsAction[] = [
  'allow',
  'block',
  'unallow',
  'unblock',
];

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

  const action = LIST_ACTIONS.find((candidate) => candidate === actionRaw);
  if (action) {
    const values = rest.flatMap((entry) =>
      entry
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    );
    if (values.length === 0) {
      throw new Error(
        `Usage: venfork workflows ${action} <workflow-file> [more-workflow-files]`
      );
    }
    return { action, workflows: values };
  }

  throw new Error(`Usage: ${USAGE}`);
}

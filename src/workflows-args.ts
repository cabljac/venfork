import { UsageError } from './errors.js';
import { isPromptFlag, scanArgs, unexpectedArgument } from './shared/args.js';
import { JSON_FLAG } from './shared/json-output.js';

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
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

const USAGE =
  'venfork workflows <status|allow|block|unallow|unblock|clear> [workflow-file ...] [--no-input] [--json]';

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
  let json = false;
  const [actionRaw = 'status', ...rest] = scanArgs(
    workflowsArgs,
    USAGE,
    (arg) => {
      if (isPromptFlag(arg)) return 0;
      if (arg !== JSON_FLAG) return undefined;
      json = true;
      return 0;
    }
  );

  if (actionRaw === 'status' || actionRaw === 'clear') {
    if (rest.length > 0) throw unexpectedArgument(rest[0], USAGE);
    return { action: actionRaw, workflows: [], json };
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
      throw new UsageError(
        `Usage: venfork workflows ${action} <workflow-file> [more-workflow-files]`
      );
    }
    return { action, workflows: values, json };
  }

  throw new UsageError(`Usage: ${USAGE}`);
}

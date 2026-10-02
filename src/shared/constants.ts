import { getSyncWorkflowPath } from '../workflow.js';

/**
 * Hard cap in ms for a single network git/gh op: `VENFORK_GIT_TIMEOUT` when
 * set to a positive number, else 10 minutes. Read on every call, so the
 * value in effect when the command runs wins.
 */
export function gitNetTimeoutMs(): number {
  const configured = Number(process.env.VENFORK_GIT_TIMEOUT);
  return Number.isFinite(configured) && configured > 0 ? configured : 600_000;
}

/** Env applied to every network git/gh op so a misconfigured credential or
 *  SSH path fails fast instead of blocking on an invisible prompt. */
export const NET_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
};

/** Repo-relative path of the managed sync workflow file. */
export const SYNC_WORKFLOW_PATH = getSyncWorkflowPath();
/** Directory GitHub Actions reads workflow files from. */
export const WORKFLOWS_DIR = '.github/workflows';
/** Author name for venfork-managed commits. */
export const VENFORK_BOT_NAME = 'venfork-bot';
/** Author email for venfork-managed commits. */
export const VENFORK_BOT_EMAIL = 'venfork-bot@users.noreply.github.com';

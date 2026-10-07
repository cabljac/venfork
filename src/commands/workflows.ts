import * as p from '@clack/prompts';
import {
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfigPatch,
} from '../config.js';
import { CommandExitError } from '../errors.js';
import { normalizeWorkflowList } from '../shared/mirror-commit.js';
import type { WorkflowsAction } from '../workflows-args.js';

const LIST_EDITS: Record<
  'allow' | 'block' | 'unallow' | 'unblock',
  {
    patch: keyof VenforkConfigPatch &
      `${'enabled' | 'disabled'}Workflows${'Add' | 'Remove'}`;
    list: 'enabledWorkflows' | 'disabledWorkflows';
    label: string;
  }
> = {
  allow: {
    patch: 'enabledWorkflowsAdd',
    list: 'enabledWorkflows',
    label: 'Allowed workflow files',
  },
  unallow: {
    patch: 'enabledWorkflowsRemove',
    list: 'enabledWorkflows',
    label: 'Allowed workflow files',
  },
  block: {
    patch: 'disabledWorkflowsAdd',
    list: 'disabledWorkflows',
    label: 'Blocked workflow files',
  },
  unblock: {
    patch: 'disabledWorkflowsRemove',
    list: 'disabledWorkflows',
    label: 'Blocked workflow files',
  },
};

/**
 * Workflows command: shows or edits the workflow allowlist and block list in
 * venfork-config. `allow`/`block` add files, `unallow`/`unblock` remove
 * them, `clear` empties both.
 */
export async function workflowsCommand(
  action: WorkflowsAction,
  workflows: string[]
): Promise<void> {
  p.intro('🧩 Venfork Workflows');
  const repoDir = process.cwd();

  try {
    if (action === 'status') {
      const config = await readVenforkConfigFromRepo(repoDir);
      if (!config) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const allowlist = config.enabledWorkflows ?? [];
      const blocklist = config.disabledWorkflows ?? [];
      if (allowlist.length === 0 && blocklist.length === 0) {
        p.note(
          'No workflow policy configured. Mirror keeps all upstream workflows unless schedule logic modifies them.',
          'Workflows Status'
        );
      } else {
        const lines = [
          `enabledWorkflows: ${allowlist.length > 0 ? 'set' : 'not set'}`,
          `disabledWorkflows: ${blocklist.length > 0 ? 'set' : 'not set'}`,
          allowlist.length > 0
            ? `Allowed files:\n${allowlist.map((name) => `- ${name}`).join('\n')}`
            : '',
          blocklist.length > 0
            ? `Blocked files:\n${blocklist.map((name) => `- ${name}`).join('\n')}`
            : '',
          allowlist.length > 0
            ? 'Precedence: enabledWorkflows allowlist overrides disabledWorkflows.'
            : '',
        ].filter((line) => line.length > 0);
        p.note(lines.join('\n'), 'Workflow Policy');
      }
      p.outro('✨ Workflows status shown');
      return;
    }

    if (action === 'clear') {
      await updateVenforkConfig(repoDir, {
        enabledWorkflows: null,
        disabledWorkflows: null,
      });
      p.outro(
        '✨ Workflow policy cleared. Run `venfork sync` to apply on the private mirror default branch.'
      );
      return;
    }

    const names = normalizeWorkflowList(workflows);
    const { patch, list, label } = LIST_EDITS[action];
    const updated = await updateVenforkConfig(repoDir, { [patch]: names });
    const current = updated[list] ?? [];
    p.note(
      current.length > 0
        ? current.map((name) => `- ${name}`).join('\n')
        : '(empty)',
      label
    );
    p.outro(
      '✨ Workflow policy updated. Run `venfork sync` to apply on the private mirror default branch.'
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Workflows command failed');
    throw new CommandExitError(1);
  }
}

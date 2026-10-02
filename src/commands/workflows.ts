import * as p from '@clack/prompts';
import { readVenforkConfigFromRepo, updateVenforkConfig } from '../config.js';
import { normalizeWorkflowList } from '../shared/mirror-commit.js';

/**
 * Workflows command: manage workflow allowlist in venfork-config.
 */
export async function workflowsCommand(
  action: 'status' | 'allow' | 'block' | 'clear',
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

    const normalized = normalizeWorkflowList(workflows);
    if (action === 'allow') {
      await updateVenforkConfig(repoDir, { enabledWorkflows: normalized });
      p.note(
        normalized.map((name) => `- ${name}`).join('\n'),
        'Allowed workflow files'
      );
      p.outro(
        '✨ Workflow allowlist updated. Run `venfork sync` to apply on the private mirror default branch.'
      );
      return;
    }

    await updateVenforkConfig(repoDir, { disabledWorkflows: normalized });
    p.note(
      normalized.map((name) => `- ${name}`).join('\n'),
      'Blocked workflow files'
    );
    p.outro(
      '✨ Workflow blocklist updated. Run `venfork sync` to apply on the private mirror default branch.'
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Workflows command failed');
    process.exit(1);
  }
}

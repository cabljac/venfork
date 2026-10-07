import * as p from '@clack/prompts';
import { $ } from 'execa';
import { readVenforkConfigFromRepo } from '../config.js';
import { CommandExitError } from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { applyConfigChange } from '../shared/config-change.js';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';
import { isValidCronExpression } from '../shared/cron.js';
import { netFetch } from '../shared/net.js';
import {
  OPEN_WORKFLOWS_WARNING,
  pushTokenAdvice,
} from '../shared/push-token.js';
import { parseRepoPath } from '../utils.js';

/**
 * Schedule command: Configure automated sync via GitHub Actions workflow.
 */
export async function scheduleCommand(
  action?: string,
  value?: string
): Promise<void> {
  p.intro('⏰ Venfork Schedule');
  const repoDir = process.cwd();
  const s = p.spinner();

  try {
    if (action === 'set') {
      const cron = value?.trim();
      if (!cron) {
        p.log.error('Cron expression is required');
        p.outro('Usage: venfork schedule set "<cron>"');
        throw new CommandExitError(1);
      }
      if (!isValidCronExpression(cron)) {
        p.log.error('Invalid cron expression (expected 5 fields)');
        p.outro('Usage: venfork schedule set "<cron>"');
        throw new CommandExitError(1);
      }

      s.start('Updating schedule and the workflow on the default branch');
      const updated = await applyConfigChange(
        repoDir,
        { schedule: { enabled: true, cron } },
        { allowInvalidCron: true }
      );
      s.stop('Schedule and workflow updated');
      const defaultBranch = await getDefaultBranch('upstream', repoDir);

      let mirrorPath = '<owner>/<mirror>';
      try {
        const originUrl = (
          await $({ cwd: repoDir })`git remote get-url origin`
        ).stdout.trim();
        const parsed = parseRepoPath(originUrl);
        if (parsed) {
          mirrorPath = parsed;
        }
      } catch {
        // Best-effort: fall back to placeholder.
      }

      const tokenPurpose =
        updated.mode === 'no-public'
          ? 'so the workflow can push upstream commits that change .github/workflows (the job token cannot)'
          : 'so the workflow can push to the public fork and push upstream commits that change .github/workflows (the job token can do neither)';
      if (
        (updated.enabledWorkflows ?? []).length === 0 &&
        (updated.disabledWorkflows ?? []).length === 0
      ) {
        p.log.warn(OPEN_WORKFLOWS_WARNING);
      }
      p.outro(
        `✨ Scheduled sync enabled\n\nBranch: ${defaultBranch}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}\n\nNext: set VENFORK_PUSH_TOKEN ${tokenPurpose}.\n${pushTokenAdvice(mirrorPath, updated.mode === 'no-public')}\n(skip if VENFORK_PUSH_TOKEN is already configured)`
      );
      return;
    }

    if (action === 'disable') {
      s.start('Disabling schedule and removing the workflow');
      const currentConfig = await readVenforkConfigFromRepo(repoDir, {
        allowInvalidCron: true,
      });
      if (!currentConfig) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const currentCron = currentConfig.schedule?.cron ?? '';
      await applyConfigChange(
        repoDir,
        {
          schedule: {
            enabled: false,
            cron: isValidCronExpression(currentCron)
              ? currentCron
              : '0 * * * *',
          },
        },
        { allowInvalidCron: true }
      );
      s.stop('Schedule disabled and workflow removed');
      const defaultBranch = await getDefaultBranch('upstream', repoDir);

      p.outro(
        `✨ Scheduled sync disabled\n\nBranch: ${defaultBranch}\nWorkflow removed: ${SYNC_WORKFLOW_PATH}`
      );
      return;
    }

    if (action === 'status' || !action) {
      s.start('Reading schedule configuration');
      await netFetch('upstream', repoDir);
      const defaultBranch = await getDefaultBranch('upstream', repoDir);
      const config = await readVenforkConfigFromRepo(repoDir);
      s.stop('Configuration loaded');
      if (!config) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const schedule = config.schedule;
      const enabled = Boolean(schedule?.enabled);
      const cron = schedule?.cron || '(not set)';
      p.note(
        `Branch: ${defaultBranch}\nEnabled: ${enabled ? 'yes' : 'no'}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}`,
        'Schedule Status'
      );
      p.outro('✨ Schedule status shown');
      return;
    }

    p.log.error(`Unknown schedule action: ${action}`);
    p.outro(
      'Usage: venfork schedule <status|set <cron>|disable>\nExample: venfork schedule set "0 */6 * * *"'
    );
    throw new CommandExitError(1);
  } catch (error) {
    if (error instanceof CommandExitError) throw error;
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Schedule command failed');
    throw new CommandExitError(1);
  }
}

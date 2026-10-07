import * as p from '@clack/prompts';
import {
  readVenforkConfigFromRepo,
  type ScheduleAuth,
  scheduleAuthOf,
  type VenforkConfig,
} from '../config.js';
import { getDefaultBranch } from '../git.js';
import { applyConfigChange } from '../shared/config-change.js';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';
import { isValidCronExpression } from '../shared/cron.js';
import { mirrorOriginPath } from '../shared/mirror-origin.js';
import { netFetch } from '../shared/net.js';
import {
  appAuthAdvice,
  openWorkflowsWarning,
  pushTokenAdvice,
  secretDeleteCommands,
} from '../shared/push-token.js';
import { parseRepoPath } from '../utils.js';

const MIRROR_PLACEHOLDER = '<owner>/<mirror>';

/** Options for {@link scheduleCommand}. */
export interface ScheduleOptions {
  /** Auth mode for `set`; omitted keeps the mode stored in venfork-config. */
  auth?: ScheduleAuth;
}

/**
 * Throws when App auth would need one installation token to cover a public
 * fork whose owner differs from the mirror's.
 */
function assertAppCoversPublicFork(
  config: VenforkConfig,
  mirrorPath: string | null
): void {
  if (config.mode === 'no-public' || !mirrorPath) return;
  const publicPath = parseRepoPath(config.publicForkUrl ?? '');
  if (!publicPath) return;
  const mirrorOwner = mirrorPath.split('/')[0];
  const publicOwner = publicPath.split('/')[0];
  if (mirrorOwner.toLowerCase() === publicOwner.toLowerCase()) return;
  throw new Error(
    `GitHub App auth needs the mirror and the public fork under one owner, but the mirror is ${mirrorPath} and the public fork is ${publicPath}. An App installation token covers one owner. Keep VENFORK_PUSH_TOKEN for this mirror (venfork schedule set "<cron>" --token).`
  );
}

function authLabel(auth: ScheduleAuth): string {
  return auth === 'app'
    ? 'GitHub App (secrets VENFORK_APP_CLIENT_ID, VENFORK_APP_PRIVATE_KEY)'
    : 'token (secret VENFORK_PUSH_TOKEN)';
}

/**
 * Schedule command: Configure automated sync via GitHub Actions workflow.
 *
 * @param action `status`, `set` or `disable`.
 * @param value Cron expression for `set`.
 * @param options Auth mode for `set`.
 */
export async function scheduleCommand(
  action?: string,
  value?: string,
  options: ScheduleOptions = {}
): Promise<void> {
  p.intro('⏰ Venfork Schedule');
  const repoDir = process.cwd();
  const s = p.spinner();

  try {
    if (action === 'set') {
      const cron = value?.trim();
      if (!cron) {
        p.log.error('Cron expression is required');
        p.outro('Usage: venfork schedule set "<cron>" [--app|--token]');
        process.exit(1);
      }
      if (!isValidCronExpression(cron)) {
        p.log.error('Invalid cron expression (expected 5 fields)');
        p.outro('Usage: venfork schedule set "<cron>" [--app|--token]');
        process.exit(1);
      }

      const mirrorRepo = await mirrorOriginPath(repoDir);
      const mirrorPath = mirrorRepo ?? MIRROR_PLACEHOLDER;
      const current = await readVenforkConfigFromRepo(repoDir, {
        allowInvalidCron: true,
      });
      if (!current) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const previousAuth = scheduleAuthOf(current);
      if ((options.auth ?? previousAuth) === 'app') {
        assertAppCoversPublicFork(current, mirrorRepo);
      }

      s.start('Updating schedule and the workflow on the default branch');
      const updated = await applyConfigChange(
        repoDir,
        {
          schedule: { enabled: true, cron },
          ...(options.auth
            ? { scheduleAuth: options.auth === 'app' ? 'app' : null }
            : {}),
        },
        { allowInvalidCron: true }
      );
      s.stop('Schedule and workflow updated');
      const defaultBranch = await getDefaultBranch('upstream', repoDir);
      const auth = scheduleAuthOf(updated);
      const noPublic = updated.mode === 'no-public';

      if (
        (updated.enabledWorkflows ?? []).length === 0 &&
        (updated.disabledWorkflows ?? []).length === 0
      ) {
        p.log.warn(openWorkflowsWarning(auth));
      }
      const summary = `✨ Scheduled sync enabled\n\nBranch: ${defaultBranch}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}\nAuth: ${authLabel(auth)}`;
      const leftover =
        previousAuth !== auth
          ? `\n\nThe workflow no longer reads the ${previousAuth === 'app' ? 'GitHub App secrets' : 'VENFORK_PUSH_TOKEN secret'}. Delete ${previousAuth === 'app' ? 'them' : 'it'} once the next run passes:\n${secretDeleteCommands(
              mirrorPath,
              previousAuth
            )
              .map((command) => `  ${command}`)
              .join('\n')}`
          : '';
      if (auth === 'app') {
        p.outro(
          `${summary}\n\nNext: let the workflow mint its push token from a GitHub App.\n${appAuthAdvice(mirrorPath, noPublic)}\n(skip if VENFORK_APP_CLIENT_ID and VENFORK_APP_PRIVATE_KEY are already configured)${leftover}`
        );
        return;
      }
      const tokenPurpose = noPublic
        ? 'so the workflow can push upstream commits that change .github/workflows (the job token cannot)'
        : 'so the workflow can push to the public fork and push upstream commits that change .github/workflows (the job token can do neither)';
      p.outro(
        `${summary}\n\nNext: set VENFORK_PUSH_TOKEN ${tokenPurpose}.\n${pushTokenAdvice(mirrorPath, noPublic)}\n(skip if VENFORK_PUSH_TOKEN is already configured)${leftover}`
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
      const auth = scheduleAuthOf(currentConfig);
      const mirrorPath =
        (await mirrorOriginPath(repoDir)) ?? MIRROR_PLACEHOLDER;

      p.outro(
        `✨ Scheduled sync disabled\n\nBranch: ${defaultBranch}\nWorkflow removed: ${SYNC_WORKFLOW_PATH}\n\nNothing reads the ${auth === 'app' ? 'GitHub App secrets' : 'VENFORK_PUSH_TOKEN secret'} now. Delete ${auth === 'app' ? 'them' : 'it'} unless you will turn the schedule back on (the auth mode is kept for the next schedule set):\n${secretDeleteCommands(
          mirrorPath,
          auth
        )
          .map((command) => `  ${command}`)
          .join('\n')}`
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
        `Branch: ${defaultBranch}\nEnabled: ${enabled ? 'yes' : 'no'}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}\nAuth: ${authLabel(scheduleAuthOf(config))}`,
        'Schedule Status'
      );
      p.outro('✨ Schedule status shown');
      return;
    }

    p.log.error(`Unknown schedule action: ${action}`);
    p.outro(
      'Usage: venfork schedule <status|set <cron> [--app|--token]|disable>\nExample: venfork schedule set "0 */6 * * *"'
    );
    process.exit(1);
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Schedule command failed');
    process.exit(1);
  }
}

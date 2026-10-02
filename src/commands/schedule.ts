import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  assertNoInvalidPreserve,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfigPatch,
} from '../config.js';
import { SyncDivergenceError } from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';
import { isValidCronExpression } from '../shared/cron.js';
import { checkDivergence } from '../shared/divergence.js';
import { resolveCommit, updateOriginTip } from '../shared/mirror-commit.js';
import { netFetch } from '../shared/net.js';
import { parseRepoPath } from '../utils.js';

/**
 * Applies a schedule config change and re-stamps origin/<defaultBranch> the
 * same way sync does, so the default branch is upstream plus at most one
 * deterministic managed commit. Refuses, before touching config, when
 * origin carries user commits that the re-stamp would discard.
 */
async function applyScheduleChange(
  repoDir: string,
  defaultBranch: string,
  patch: VenforkConfigPatch
): Promise<void> {
  await netFetch('upstream', repoDir);
  await netFetch('origin', repoDir);
  const current = await readVenforkConfigFromRepo(repoDir, {
    allowInvalidCron: true,
  });
  if (!current) {
    throw new Error('venfork-config branch not found or invalid');
  }
  assertNoInvalidPreserve(current);
  const upstreamTip = await resolveCommit(`upstream/${defaultBranch}`, repoDir);
  if (!upstreamTip) {
    throw new Error(
      `upstream/${defaultBranch} not found after fetch. Check the upstream remote and the default branch name.`
    );
  }
  const previousMirrorTip = await resolveCommit(
    `origin/${defaultBranch}`,
    repoDir
  );
  const originDivergence = await checkDivergence({
    remote: 'origin',
    defaultBranch,
    allowPreserved: true,
    preserveAllowed: new Set(current.preserve ?? []),
    cwd: repoDir,
  });
  if (originDivergence.count > 0) {
    throw new SyncDivergenceError(
      defaultBranch,
      { count: originDivergence.count, files: originDivergence.files },
      {
        count: 0,
        files: [],
      }
    );
  }
  const updated = await updateVenforkConfig(repoDir, patch);
  await updateOriginTip({
    config: updated,
    defaultBranch,
    upstreamTip,
    previousMirrorTip,
    cwd: repoDir,
  });
}

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
    const defaultBranch = await getDefaultBranch('upstream');

    if (action === 'set') {
      const cron = value?.trim();
      if (!cron) {
        p.log.error('Cron expression is required');
        p.outro('Usage: venfork schedule set "<cron>"');
        process.exit(1);
      }
      if (!isValidCronExpression(cron)) {
        p.log.error('Invalid cron expression (expected 5 fields)');
        p.outro('Usage: venfork schedule set "<cron>"');
        process.exit(1);
      }

      s.start('Updating schedule and the workflow on the default branch');
      await applyScheduleChange(repoDir, defaultBranch, {
        schedule: { enabled: true, cron },
      });
      s.stop('Schedule and workflow updated');

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

      p.outro(
        `✨ Scheduled sync enabled\n\nBranch: ${defaultBranch}\nCron: ${cron}\nWorkflow: ${SYNC_WORKFLOW_PATH}\n\nNext: set the cross-repo push token so the workflow can push to the public fork:\n  gh secret set VENFORK_PUSH_TOKEN --repo ${mirrorPath} --body "$(gh auth token)"\n(skip if VENFORK_PUSH_TOKEN is already configured)`
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
      await applyScheduleChange(repoDir, defaultBranch, {
        schedule: {
          enabled: false,
          cron: isValidCronExpression(currentCron) ? currentCron : '0 * * * *',
        },
      });
      s.stop('Schedule disabled and workflow removed');

      p.outro(
        `✨ Scheduled sync disabled\n\nBranch: ${defaultBranch}\nWorkflow removed: ${SYNC_WORKFLOW_PATH}`
      );
      return;
    }

    if (action === 'status' || !action) {
      s.start('Reading schedule configuration');
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
    process.exit(1);
  } catch (error) {
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Schedule command failed');
    process.exit(1);
  }
}

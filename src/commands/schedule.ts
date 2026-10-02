import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfigPatch,
} from '../config.js';
import { SyncDivergenceError } from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';
import { checkDivergence } from '../shared/divergence.js';
import { resolveCommit, updateOriginTip } from '../shared/mirror-commit.js';
import { netFetch } from '../shared/net.js';
import { parseRepoPath } from '../utils.js';

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*') {
    return true;
  }

  const isValidNumber = (value: string): boolean => {
    if (!/^\d+$/.test(value)) {
      return false;
    }
    const parsed = Number.parseInt(value, 10);
    return parsed >= min && parsed <= max;
  };

  const isValidRange = (value: string): boolean => {
    const [start, end] = value.split('-');
    if (!start || !end || !isValidNumber(start) || !isValidNumber(end)) {
      return false;
    }
    return Number.parseInt(start, 10) <= Number.parseInt(end, 10);
  };

  const stepParts = field.split('/');
  if (stepParts.length > 2) {
    return false;
  }
  if (stepParts.length === 2) {
    const [base, step] = stepParts;
    if (
      !base ||
      !step ||
      !isValidNumber(step) ||
      Number.parseInt(step, 10) <= 0
    ) {
      return false;
    }
    if (base === '*') {
      return true;
    }
    if (base.includes(',')) {
      return false;
    }
    return base.includes('-') ? isValidRange(base) : isValidNumber(base);
  }

  if (field.includes(',')) {
    return field
      .split(',')
      .every((part) =>
        part.includes('-') ? isValidRange(part) : isValidNumber(part)
      );
  }
  if (field.includes('-')) {
    return isValidRange(field);
  }
  return isValidNumber(field);
}

function isValidCronExpression(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }, // day of week
  ];

  return parts.every((part, index) => {
    const range = ranges[index];
    return isValidCronField(part, range.min, range.max);
  });
}

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
  const current = await readVenforkConfigFromRepo(repoDir);
  if (!current) {
    throw new Error('venfork-config branch not found or invalid');
  }
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
    throw new SyncDivergenceError(defaultBranch, originDivergence, {
      count: 0,
      files: [],
    });
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
      const currentConfig = await readVenforkConfigFromRepo(repoDir);
      if (!currentConfig) {
        throw new Error('venfork-config branch not found or invalid');
      }
      await applyScheduleChange(repoDir, defaultBranch, {
        schedule: {
          enabled: false,
          cron: currentConfig.schedule?.cron || '0 * * * *',
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

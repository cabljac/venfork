import {
  applyPatchAndNormalize,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfig,
  type VenforkConfigPatch,
} from '../config.js';
import { SyncDivergenceError } from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { checkDivergence } from './divergence.js';
import {
  buildOriginTip,
  pushBranchWithLease,
  resolveCommit,
} from './mirror-commit.js';
import { netFetch } from './net.js';

/**
 * Applies a config change that alters the managed commit (schedule,
 * preserve) and re-stamps `origin/<default>` to match, so origin always
 * carries the managed commit the config describes.
 *
 * Order: refuse when origin carries user commits the re-stamp would
 * discard; build the new tip (including the pinned-version guard); write
 * the config; push the tip with a lease. When the push fails, the config
 * write is rolled back with `rollback` and the push error is rethrown.
 *
 * @param repoDir Mirror checkout.
 * @param patch The config change.
 * @param rollback Patch that restores the fields `patch` changes, given the
 *   config as read before the change.
 * @param options.allowInvalidCron Read a config whose cron is invalid (so
 *   the change can replace it).
 */
export async function applyConfigChange(
  repoDir: string,
  patch: VenforkConfigPatch,
  rollback: (current: VenforkConfig) => VenforkConfigPatch,
  options: { allowInvalidCron?: boolean } = {}
): Promise<VenforkConfig> {
  await netFetch('upstream', repoDir);
  await netFetch('origin', repoDir);
  const defaultBranch = await getDefaultBranch('upstream', repoDir);
  const current = await readVenforkConfigFromRepo(repoDir, {
    allowInvalidCron: options.allowInvalidCron,
  });
  if (!current) {
    throw new Error('venfork-config branch not found or invalid');
  }
  const next = applyPatchAndNormalize(current, patch);
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
      { count: 0, files: [] }
    );
  }
  const tip = await buildOriginTip({
    config: next,
    defaultBranch,
    upstreamTip,
    previousMirrorTip,
    cwd: repoDir,
  });

  const updated = await updateVenforkConfig(repoDir, patch);
  try {
    await pushBranchWithLease({
      remote: 'origin',
      branch: defaultBranch,
      target: tip,
      expected: previousMirrorTip,
      cwd: repoDir,
    });
  } catch (err) {
    await updateVenforkConfig(repoDir, rollback(current));
    throw err;
  }
  return updated;
}

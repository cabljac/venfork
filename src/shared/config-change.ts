import {
  applyPatchAndNormalize,
  readVenforkConfigFromRepoWithSha,
  restoreVenforkConfig,
  type VenforkConfig,
  type VenforkConfigPatch,
  writeVenforkConfigAt,
} from '../config.js';
import { ConfigError, SyncDivergenceError, VenforkError } from '../errors.js';
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
 * Order: read the config at commit S; refuse when origin carries user
 * commits the re-stamp would discard; build the new tip from the patched
 * config (including the pinned-version guard); write the config with a
 * lease on S and no retry; push the tip with a lease. When the push fails,
 * `venfork-config` is pointed back at S with a lease on the commit just
 * written, and the push error is rethrown. When that rollback fails, the
 * error names both failures and both states.
 *
 * @param repoDir Mirror checkout.
 * @param patch The config change.
 * @param options.allowInvalidCron Read a config whose cron is invalid (so
 *   the change can replace it).
 */
export async function applyConfigChange(
  repoDir: string,
  patch: VenforkConfigPatch,
  options: { allowInvalidCron?: boolean } = {}
): Promise<VenforkConfig> {
  await netFetch('upstream', repoDir);
  await netFetch('origin', repoDir);
  const defaultBranch = await getDefaultBranch('upstream', repoDir);
  const read = await readVenforkConfigFromRepoWithSha(repoDir, {
    allowInvalidCron: options.allowInvalidCron,
  });
  if (!read) {
    throw new Error('venfork-config branch not found or invalid');
  }
  const { config: current, sha: readSha } = read;
  const next = applyPatchAndNormalize(current, patch);
  const upstreamTip = await resolveCommit(
    `refs/remotes/upstream/${defaultBranch}`,
    repoDir
  );
  if (!upstreamTip) {
    throw new Error(
      `upstream/${defaultBranch} not found after fetch. Check the upstream remote and the default branch name.`
    );
  }
  const previousMirrorTip = await resolveCommit(
    `refs/remotes/origin/${defaultBranch}`,
    repoDir
  );
  const originDivergence = await checkDivergence({
    base: upstreamTip,
    tip: previousMirrorTip,
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

  const writtenSha = await writeVenforkConfigAt(repoDir, next, readSha);
  try {
    await pushBranchWithLease({
      remote: 'origin',
      branch: defaultBranch,
      target: tip,
      expected: previousMirrorTip,
      cwd: repoDir,
    });
  } catch (pushError) {
    try {
      await restoreVenforkConfig(repoDir, readSha, writtenSha);
    } catch (rollbackError) {
      throw rollbackFailure({
        pushError,
        rollbackError,
        defaultBranch,
        writtenSha,
        previousMirrorTip,
      });
    }
    throw pushError;
  }
  return next;
}

function rollbackFailure(args: {
  pushError: unknown;
  rollbackError: unknown;
  defaultBranch: string;
  writtenSha: string;
  previousMirrorTip: string;
}): VenforkError {
  const {
    pushError,
    rollbackError,
    defaultBranch,
    writtenSha,
    previousMirrorTip,
  } = args;
  const message = (err: unknown) =>
    err instanceof Error ? err.message : String(err);
  const conflict =
    rollbackError instanceof ConfigError && rollbackError.reason === 'conflict';
  const origin = previousMirrorTip || '(no branch)';
  return new VenforkError(
    [
      message(pushError),
      conflict
        ? `venfork-config changed concurrently after this command wrote ${writtenSha}, so it was not rolled back.`
        : `Rolling venfork-config back failed: ${message(rollbackError)}`,
      `State: venfork-config ${conflict ? 'moved past' : 'is at'} ${writtenSha}; origin/${defaultBranch} was at ${origin} when the push failed.`,
      'venfork-config may be ahead of origin: run `venfork sync` once origin is reachable.',
    ].join('\n')
  );
}

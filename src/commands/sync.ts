import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  assertNoInvalidPreserve,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfig,
} from '../config.js';
import { ConfigError, SyncDivergenceError } from '../errors.js';
import { getDefaultBranch } from '../git.js';
import {
  checkDivergence,
  type DroppedManagedCommit,
  formatDivergenceReport,
} from '../shared/divergence.js';
import {
  hasManagedTrailer,
  isManagedCommit,
} from '../shared/managed-commit.js';
import {
  pushBranchWithLease,
  resolveCommit,
  updateOriginTip,
} from '../shared/mirror-commit.js';
import { netExec, netFailureReason, netFetch } from '../shared/net.js';
import { assertPreserveEntriesAreNotDirectories } from '../shared/stage-gate.js';
import {
  reportSyncBlocked,
  resolveSyncBlocked,
} from '../shared/sync-report.js';

/**
 * Returns the upstream PR number for `branch` if it's a pulled-in PR. First
 * checks `venfork-config.pulledPrs` (recorded by `venfork pull pr`),
 * then falls back to the `upstream-pr/<n>` naming convention. Returns null
 * if the branch is not a pulled PR (sync routes to the default flow).
 */
function resolvePulledPr(
  branch: string,
  config: VenforkConfig | null
): { prNumber: number; tracked: boolean } | null {
  const recorded = config?.pulledPrs?.[branch];
  if (recorded?.upstreamPrNumber) {
    return { prNumber: recorded.upstreamPrNumber, tracked: true };
  }
  const conventionMatch = branch.match(/^upstream-pr\/(\d+)$/);
  if (conventionMatch) {
    return { prNumber: Number(conventionMatch[1]), tracked: false };
  }
  return null;
}

async function syncPulledPr(
  branch: string,
  prNumber: number,
  cwd: string,
  s: ReturnType<typeof p.spinner>
): Promise<void> {
  s.start(`Fetching pull/${prNumber}/head from upstream`);
  const fetchResult = await netExec(cwd, {
    bufferOutput: true,
  })`git fetch upstream pull/${prNumber}/head:${branch}`;
  if (fetchResult.exitCode !== 0) {
    // git fetch refuses to clobber a divergent local branch; force into the
    // local ref since the source of truth for pulled PRs is upstream.
    const forceResult = await netExec(cwd, {
      bufferOutput: true,
    })`git fetch upstream +pull/${prNumber}/head:${branch}`;
    if (forceResult.exitCode !== 0) {
      throw new Error(
        `git fetch upstream pull/${prNumber}/head failed: ${netFailureReason(forceResult)}`
      );
    }
  }
  const headSha = (await $({ cwd })`git rev-parse ${branch}`).stdout.trim();
  s.stop(`Fetched ${headSha.slice(0, 9)} → ${branch}`);

  s.start(`Pushing ${branch} to origin`);
  try {
    await pushBranchWithLease({
      remote: 'origin',
      branch,
      target: headSha,
      expected: await resolveCommit(`origin/${branch}`, cwd),
      cwd,
    });
  } catch (err) {
    s.stop('Push failed');
    p.log.warn(
      `Could not push ${branch} to origin: ${err instanceof Error ? err.message : String(err)}`
    );
    p.log.warn(
      'Local branch is updated; the mirror copy was not. Skipping pulledPrs config update — the recorded head/lastSyncedAt would not match the mirror.'
    );
    return;
  }
  s.stop(`Pushed ${branch} to origin`);

  try {
    await updateVenforkConfig(cwd, {
      pulledPrs: {
        [branch]: {
          upstreamPrNumber: prNumber,
          upstreamPrUrl: `https://github.com/${(
            await $({ cwd })`git remote get-url upstream`
          ).stdout
            .trim()
            .replace(
              /.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
              '$1'
            )}/pull/${prNumber}`,
          head: headSha,
          lastSyncedAt: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.warn(`Could not update pulledPrs entry: ${msg}`);
  }
}

/**
 * Warns, before anything is pushed, about commits that sync will replace
 * because they look venfork-managed without carrying the trailer.
 */
function warnWeakManaged(commits: DroppedManagedCommit[]): void {
  if (commits.length === 0) return;
  p.log.warn(
    `Treating ${commits.length} commit(s) as venfork-managed without the Venfork-Managed trailer; sync replaces them:\n${commits
      .map(({ commit, kind }) => `  - ${commit.slice(0, 12)} (${kind})`)
      .join('\n')}`
  );
}

/**
 * Sync command: Update default branches of origin and public to match upstream.
 *
 * With `reportIssues` (set by the generated workflow), a divergence opens or
 * refreshes a `venfork-sync-blocked` issue on the mirror, and a successful
 * sync closes it.
 */
export async function syncCommand(
  targetBranch?: string,
  options?: { cwd?: string; quiet?: boolean; reportIssues?: boolean }
): Promise<void> {
  const quiet = options?.quiet ?? false;

  if (!quiet) {
    p.intro('🔄 Venfork Sync');
  }

  const s = p.spinner();

  try {
    const repoDir = options?.cwd ?? process.cwd();

    // Branch-specific path: if the targetBranch is a pulled-in upstream PR,
    // refresh it from `pull/<n>/head` instead of running the default-branch
    // +1-commit sync flow.
    if (targetBranch) {
      const initialConfig = await readVenforkConfigFromRepo(repoDir);
      const pulledPr = resolvePulledPr(targetBranch, initialConfig);
      if (pulledPr) {
        await syncPulledPr(targetBranch, pulledPr.prNumber, repoDir, s);
        if (!quiet) {
          p.outro(
            `✨ ${targetBranch} synced with upstream PR #${pulledPr.prNumber}`
          );
        }
        return;
      }
    }

    const config = await readVenforkConfigFromRepo(repoDir);
    assertNoInvalidPreserve(config);
    const noPublic = config?.mode === 'no-public';

    // Step 1: Fetch from upstream
    s.start('Fetching from upstream');
    await netFetch('upstream', options?.cwd);
    await netFetch('origin', options?.cwd);
    if (!noPublic) {
      await netFetch('public', options?.cwd);
    }
    s.stop('Fetched from all remotes');

    // Step 2: Detect default branch if not specified
    const defaultBranch =
      targetBranch || (await getDefaultBranch('upstream', options?.cwd));
    const preserveList = config?.preserve ?? [];
    const upstreamTip = await resolveCommit(
      `upstream/${defaultBranch}`,
      options?.cwd
    );
    if (!upstreamTip) {
      throw new Error(
        `upstream/${defaultBranch} not found after fetch. Check the upstream remote and the default branch name.`
      );
    }

    if (config === null) {
      const originTip = await resolveCommit(
        `origin/${defaultBranch}`,
        options?.cwd
      );
      if (
        originTip &&
        originTip !== upstreamTip &&
        ((await hasManagedTrailer(originTip, options?.cwd)) ||
          (await isManagedCommit(originTip, options?.cwd)))
      ) {
        throw new Error(
          `The venfork-config branch is missing but origin/${defaultBranch} carries venfork state (a managed commit). Restore the venfork-config branch, or run \`venfork setup\` only on a fresh mirror.`
        );
      }
    }

    await assertPreserveEntriesAreNotDirectories(
      preserveList,
      [`refs/remotes/origin/${defaultBranch}`],
      repoDir
    );

    // Step 3: Check for divergence
    s.start('Checking for divergent commits');

    // `allowPreserved` is asymmetric on purpose: mirror-only files live on
    // origin (the private mirror) and never get pushed to public. So a
    // preserved-only commit on origin is expected and benign, but the same
    // shape on public would mean someone pushed to public outside venfork —
    // which is a real divergence we want to abort on.
    // Build the allowlist Set once outside the per-remote loop — both
    // origin and public divergence checks reuse it across however many
    // divergent commits each remote has.
    const preserveAllowed = new Set(preserveList);
    const originDivergence = await checkDivergence({
      remote: 'origin',
      defaultBranch,
      allowPreserved: true,
      preserveAllowed,
      cwd: options?.cwd,
    });
    const publicDivergence = noPublic
      ? { count: 0, files: [] as string[], weakManaged: [] }
      : await checkDivergence({
          remote: 'public',
          defaultBranch,
          allowPreserved: false,
          preserveAllowed,
          cwd: options?.cwd,
        });

    s.stop('Checked for divergence');

    // Step 4: Abort if divergent commits exist
    if (originDivergence.count > 0 || publicDivergence.count > 0) {
      const divergence = new SyncDivergenceError(
        defaultBranch,
        { count: originDivergence.count, files: originDivergence.files },
        { count: publicDivergence.count, files: publicDivergence.files }
      );
      const report = formatDivergenceReport(divergence);
      p.log.warn('Divergent commits detected:');
      p.note(report, '⚠️  Warning');
      if (options?.reportIssues) {
        await reportSyncBlocked({ cwd: repoDir, error: divergence });
      }
      throw divergence;
    }

    warnWeakManaged([
      ...originDivergence.weakManaged,
      ...publicDivergence.weakManaged,
    ]);

    // Read before anything is pushed: preserved files come from this tip, and
    // it is the lease for the origin push.
    const previousMirrorTip = await resolveCommit(
      `origin/${defaultBranch}`,
      options?.cwd
    );

    s.start(`Syncing ${defaultBranch} to origin`);
    const { pushed: originPushed } = await updateOriginTip({
      config,
      defaultBranch,
      upstreamTip,
      previousMirrorTip,
      cwd: options?.cwd,
    });
    s.stop(
      originPushed
        ? `Updated origin/${defaultBranch}`
        : `origin/${defaultBranch} already up to date`
    );

    if (!noPublic) {
      s.start(`Syncing ${defaultBranch} to public`);
      const publicPushed = await pushBranchWithLease({
        remote: 'public',
        branch: defaultBranch,
        target: upstreamTip,
        expected: await resolveCommit(`public/${defaultBranch}`, options?.cwd),
        cwd: options?.cwd,
      });
      s.stop(
        publicPushed
          ? `Updated public/${defaultBranch}`
          : `public/${defaultBranch} already up to date`
      );
    }

    if (options?.reportIssues) {
      await resolveSyncBlocked({ cwd: repoDir });
    }

    if (!quiet) {
      p.outro(
        noPublic
          ? `✨ Sync complete! origin/${defaultBranch} is now up to date with upstream/${defaultBranch}`
          : `✨ Sync complete! origin/${defaultBranch} and public/${defaultBranch} are now up to date with upstream/${defaultBranch}`
      );
    }
  } catch (error) {
    if (error instanceof SyncDivergenceError || error instanceof ConfigError) {
      if (error instanceof ConfigError) s.stop('Config error');
      throw error;
    }
    s.stop('Error occurred');
    p.log.error(error instanceof Error ? error.message : String(error));
    if (!quiet) {
      p.outro('❌ Sync failed');
    }
    process.exit(1);
  }
}

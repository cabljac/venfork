import { $ } from 'execa';
import {
  assertNoInvalidPreserve,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfig,
} from '../config.js';
import {
  ConfigError,
  GitError,
  PreconditionError,
  SyncDivergenceError,
} from '../errors.js';
import { getDefaultBranch } from '../git.js';
import {
  checkDivergence,
  type DroppedManagedCommit,
  divergenceError,
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
import * as p from '../shared/ui.js';

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

/** `--json` result of a default-branch sync. */
export interface DefaultBranchSyncResult {
  kind: 'default-branch';
  /** `pushed` when origin or public moved, else `up-to-date`. */
  status: 'pushed' | 'up-to-date';
  branch: string;
  upstreamTip: string;
  origin: { tip: string; pushed: boolean };
  /** Absent in no-public mode. */
  public?: { tip: string; pushed: boolean };
}

/** `--json` result of `venfork sync <branch>` on a pulled upstream PR. */
export interface PulledPrSyncResult {
  kind: 'pulled-pr';
  /** `push-failed` when the local branch moved but origin could not. */
  status: 'pushed' | 'up-to-date' | 'push-failed';
  branch: string;
  prNumber: number;
  head: string;
}

/** What `venfork sync` did, reported as the `--json` result. */
export type SyncResult = DefaultBranchSyncResult | PulledPrSyncResult;

async function syncPulledPr(
  branch: string,
  prNumber: number,
  cwd: string,
  s: ReturnType<typeof p.spinner>
): Promise<PulledPrSyncResult> {
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
      throw new GitError(
        `git fetch upstream pull/${prNumber}/head failed: ${netFailureReason(forceResult)}`,
        'git fetch upstream'
      );
    }
  }
  const headSha = (await $({ cwd })`git rev-parse ${branch}`).stdout.trim();
  s.stop(`Fetched ${headSha.slice(0, 9)} → ${branch}`);

  s.start(`Pushing ${branch} to origin`);
  const result: PulledPrSyncResult = {
    kind: 'pulled-pr',
    status: 'up-to-date',
    branch,
    prNumber,
    head: headSha,
  };
  try {
    const pushed = await pushBranchWithLease({
      remote: 'origin',
      branch,
      target: headSha,
      expected: await resolveCommit(`refs/remotes/origin/${branch}`, cwd),
      cwd,
    });
    if (pushed) result.status = 'pushed';
  } catch (err) {
    s.stop('Push failed');
    p.log.warn(
      `Could not push ${branch} to origin: ${err instanceof Error ? err.message : String(err)}`
    );
    p.log.warn(
      'Local branch is updated; the mirror copy was not. Skipping pulledPrs config update — the recorded head/lastSyncedAt would not match the mirror.'
    );
    return { ...result, status: 'push-failed' };
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
  return result;
}

/**
 * Warns, before anything is pushed, about commits that sync will replace
 * on a weaker signal than a current managed commit.
 */
function warnWeakManaged(commits: DroppedManagedCommit[]): void {
  const stale = commits.filter(({ kind }) => kind === 'stale-trailer');
  const untrailed = commits.filter(({ kind }) => kind !== 'stale-trailer');
  if (stale.length > 0) {
    p.log.warn(
      `Replacing ${stale.length} venfork-managed commit(s) that no longer match the preserve list or workflow policy; this discards their changes:\n${stale
        .map(
          ({ commit, kind, staleFiles }) =>
            `  - ${commit.slice(0, 12)} (${kind}): ${staleFiles.join(', ')}`
        )
        .join('\n')}`
    );
  }
  if (untrailed.length > 0) {
    p.log.warn(
      `Treating ${untrailed.length} commit(s) as venfork-managed without the Venfork-Managed trailer; sync replaces them:\n${untrailed
        .map(({ commit, kind }) => `  - ${commit.slice(0, 12)} (${kind})`)
        .join('\n')}`
    );
  }
}

/**
 * Sync command: Update default branches of origin and public to match upstream.
 *
 * With `reportIssues` (set by the generated workflow), a divergence opens or
 * refreshes a `venfork-sync-blocked` issue on the mirror, and a successful
 * sync closes it.
 * @returns What sync did, for `--json`.
 */
export async function syncCommand(
  targetBranch?: string,
  options?: { cwd?: string; quiet?: boolean; reportIssues?: boolean }
): Promise<SyncResult> {
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
        const result = await syncPulledPr(
          targetBranch,
          pulledPr.prNumber,
          repoDir,
          s
        );
        if (!quiet) {
          p.outro(
            `✨ ${targetBranch} synced with upstream PR #${pulledPr.prNumber}`
          );
        }
        return result;
      }
    }

    // Fetch before reading the config: config writers write the config
    // before they push the tip, so a tip fetched after the config was read
    // can carry preserve entries the config does not name yet.
    s.start('Fetching from upstream');
    await netFetch('upstream', options?.cwd);
    await netFetch('origin', options?.cwd);
    const config = await readVenforkConfigFromRepo(repoDir);
    assertNoInvalidPreserve(config);
    const noPublic = config?.mode === 'no-public';
    if (!noPublic) {
      await netFetch('public', options?.cwd);
    }
    s.stop('Fetched from all remotes');

    // Step 2: Detect default branch if not specified
    const defaultBranch =
      targetBranch || (await getDefaultBranch('upstream', options?.cwd));
    const preserveList = config?.preserve ?? [];
    const upstreamTip = await resolveCommit(
      `refs/remotes/upstream/${defaultBranch}`,
      options?.cwd
    );
    if (!upstreamTip) {
      throw new PreconditionError(
        `upstream/${defaultBranch} not found after fetch. Check the upstream remote and the default branch name.`
      );
    }
    // Resolved once: this id is the range the divergence check reads, the
    // source of the preserved blobs and the lease for the origin push.
    const previousMirrorTip = await resolveCommit(
      `refs/remotes/origin/${defaultBranch}`,
      options?.cwd
    );
    const publicTip = noPublic
      ? ''
      : await resolveCommit(
          `refs/remotes/public/${defaultBranch}`,
          options?.cwd
        );

    if (config === null) {
      if (
        previousMirrorTip &&
        previousMirrorTip !== upstreamTip &&
        ((await hasManagedTrailer(previousMirrorTip, options?.cwd)) ||
          (await isManagedCommit(previousMirrorTip, options?.cwd)))
      ) {
        throw new PreconditionError(
          `The venfork-config branch is missing but origin/${defaultBranch} carries venfork state (a managed commit). Restore the venfork-config branch, or run \`venfork setup\` only on a fresh mirror.`
        );
      }
    }

    await assertPreserveEntriesAreNotDirectories(
      preserveList,
      previousMirrorTip ? [previousMirrorTip] : [],
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
      base: upstreamTip,
      tip: previousMirrorTip,
      allowPreserved: true,
      preserveAllowed,
      workflowPolicy: {
        enabledWorkflows: config?.enabledWorkflows ?? [],
        disabledWorkflows: config?.disabledWorkflows ?? [],
      },
      cwd: options?.cwd,
    });
    const publicDivergence = noPublic
      ? { count: 0, files: [] as string[], weakManaged: [] }
      : await checkDivergence({
          base: upstreamTip,
          tip: publicTip,
          allowPreserved: false,
          preserveAllowed,
          cwd: options?.cwd,
        });

    s.stop('Checked for divergence');

    // Step 4: Abort if divergent commits exist
    if (originDivergence.count > 0 || publicDivergence.count > 0) {
      const divergence = divergenceError(
        defaultBranch,
        { count: originDivergence.count, files: originDivergence.files },
        { count: publicDivergence.count, files: publicDivergence.files }
      );
      if (options?.reportIssues) {
        await reportSyncBlocked({ cwd: repoDir, error: divergence });
      }
      throw divergence;
    }

    warnWeakManaged([
      ...originDivergence.weakManaged,
      ...publicDivergence.weakManaged,
    ]);

    s.start(`Syncing ${defaultBranch} to origin`);
    const { tip: originTip, pushed: originPushed } = await updateOriginTip({
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

    let publicResult: DefaultBranchSyncResult['public'];
    if (!noPublic) {
      s.start(`Syncing ${defaultBranch} to public`);
      const publicPushed = await pushBranchWithLease({
        remote: 'public',
        branch: defaultBranch,
        target: upstreamTip,
        expected: publicTip,
        cwd: options?.cwd,
      });
      s.stop(
        publicPushed
          ? `Updated public/${defaultBranch}`
          : `public/${defaultBranch} already up to date`
      );
      publicResult = { tip: upstreamTip, pushed: publicPushed };
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
    return {
      kind: 'default-branch',
      status: originPushed || publicResult?.pushed ? 'pushed' : 'up-to-date',
      branch: defaultBranch,
      upstreamTip,
      origin: { tip: originTip, pushed: originPushed },
      ...(publicResult ? { public: publicResult } : {}),
    };
  } catch (error) {
    if (error instanceof SyncDivergenceError || error instanceof ConfigError) {
      s.clear();
      throw error;
    }
    throw p.reportFailure(error, s);
  }
}

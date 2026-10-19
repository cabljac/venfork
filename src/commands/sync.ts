import {
  assertNoInvalidPreserve,
  readVenforkConfigFromRepo,
} from '../config.js';
import {
  ConfigError,
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
import { netFetch } from '../shared/net.js';
import { assertPreserveEntriesAreNotDirectories } from '../shared/stage-gate.js';
import {
  reportSyncBlocked,
  resolveSyncBlocked,
} from '../shared/sync-report.js';
import * as p from '../shared/ui.js';

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

/** What `venfork sync` did, reported as the `--json` result. */
export type SyncResult = DefaultBranchSyncResult;

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
export async function syncCommand(options?: {
  cwd?: string;
  quiet?: boolean;
  reportIssues?: boolean;
}): Promise<SyncResult> {
  const quiet = options?.quiet ?? false;

  if (!quiet) {
    p.intro('🔄 Venfork Sync');
  }

  const s = p.spinner();

  try {
    const repoDir = options?.cwd ?? process.cwd();

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
    const defaultBranch = await getDefaultBranch('upstream', options?.cwd);
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
    // shape on public would mean someone pushed to public outside venfork -
    // which is a real divergence we want to abort on.
    // Build the allowlist Set once outside the per-remote loop - both
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

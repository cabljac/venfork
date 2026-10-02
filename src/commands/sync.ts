import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  normalizePreservePath,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfig,
} from '../config.js';
import { SyncDivergenceError } from '../errors.js';
import { getDefaultBranch } from '../git.js';
import { checkDivergence } from '../shared/divergence.js';
import { applyMirrorPlusOneCommit } from '../shared/mirror-commit.js';

/**
 * Returns the upstream PR number for `branch` if it's a pulled-in PR. First
 * checks `venfork-config.pulledPrs` (recorded by `venfork pull-request`),
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
  const fetchResult = await $({
    cwd,
    reject: false,
  })`git fetch upstream pull/${prNumber}/head:${branch}`;
  if (fetchResult.exitCode !== 0) {
    // git fetch refuses to clobber a divergent local branch; force into the
    // local ref since the source of truth for pulled PRs is upstream.
    const forceResult = await $({
      cwd,
      reject: false,
    })`git fetch upstream +pull/${prNumber}/head:${branch}`;
    if (forceResult.exitCode !== 0) {
      throw new Error(
        `git fetch upstream pull/${prNumber}/head failed:\n${(forceResult.stderr || fetchResult.stderr).trim()}`
      );
    }
  }
  const headSha = (await $({ cwd })`git rev-parse ${branch}`).stdout.trim();
  s.stop(`Fetched ${headSha.slice(0, 9)} → ${branch}`);

  s.start(`Pushing ${branch} to origin`);
  const pushResult = await $({
    cwd,
    reject: false,
  })`git push origin ${branch} --force-with-lease`;
  if (pushResult.exitCode !== 0) {
    s.stop('Push failed');
    p.log.warn(
      `Could not push ${branch} to origin: ${pushResult.stderr.trim()}`
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
 * Sync command: Update default branches of origin and public to match upstream
 */
export async function syncCommand(
  targetBranch?: string,
  options?: { cwd?: string; quiet?: boolean }
): Promise<void> {
  const cwdOpt = options?.cwd ? { cwd: options.cwd } : {};
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
    const noPublic = config?.mode === 'no-public';

    // Step 1: Fetch from upstream
    s.start('Fetching from upstream');
    await $(cwdOpt)`git fetch upstream`;
    await $(cwdOpt)`git fetch origin`;
    if (!noPublic) {
      await $(cwdOpt)`git fetch public`;
    }
    s.stop('Fetched from all remotes');

    // Step 2: Detect default branch if not specified
    const defaultBranch =
      targetBranch || (await getDefaultBranch('upstream', options?.cwd));
    const scheduleConfig = config?.schedule;
    const enabledWorkflows = config?.enabledWorkflows ?? [];
    const disabledWorkflows = config?.disabledWorkflows ?? [];
    const preserveList = config?.preserve ?? [];

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
      ? { count: 0, files: [] as string[] }
      : await checkDivergence({
          remote: 'public',
          defaultBranch,
          allowPreserved: false,
          preserveAllowed,
          cwd: options?.cwd,
        });

    s.stop('Checked for divergence');

    // Step 4: Warn if divergent commits exist
    if (originDivergence.count > 0 || publicDivergence.count > 0) {
      const warnings: string[] = [];
      if (originDivergence.count > 0) {
        warnings.push(
          `  • origin/${defaultBranch} has ${originDivergence.count} commit(s) not in upstream`
        );
      }
      if (publicDivergence.count > 0) {
        warnings.push(
          `  • public/${defaultBranch} has ${publicDivergence.count} commit(s) not in upstream`
        );
      }

      // When origin diverges, surface the changed files and a concrete
      // `venfork preserve add ...` hint. Most likely cause is a mirror-only
      // file the user committed directly (or one whose preserve entry was
      // just removed) — both cases resolve with `preserve add`. Public
      // divergence does NOT get this hint: preserve doesn't apply to public,
      // so suggesting it would mislead.
      const sections: string[] = [warnings.join('\n')];
      if (originDivergence.files.length > 0) {
        sections.push(
          `Files changed by divergent commits on origin/${defaultBranch}:\n${originDivergence.files
            .map((f) => `  • ${f}`)
            .join('\n')}`
        );
        // Only suggest preserve for paths the validator would actually
        // accept — otherwise the copy/paste command line would fail.
        // If every divergent path is invalid for preserve, suppress the hint
        // entirely (rebase/force-sync below still apply).
        const validForPreserve: string[] = [];
        const invalidForPreserve: string[] = [];
        for (const file of originDivergence.files) {
          if (normalizePreservePath(file) !== null) {
            validForPreserve.push(file);
          } else {
            invalidForPreserve.push(file);
          }
        }
        if (validForPreserve.length > 0) {
          sections.push(
            `If these are mirror-only files you want to keep across sync, add them to preserve:\n  venfork preserve add ${validForPreserve.join(' ')}`
          );
          if (invalidForPreserve.length > 0) {
            sections.push(
              `(skipped from the hint — paths can't be expressed in the preserve allowlist: ${invalidForPreserve.join(', ')})`
            );
          }
        }
      }
      sections.push(
        `Otherwise:\n- Rebase or cherry-pick to a feature branch before running sync\n- Force-sync (DESTRUCTIVE — permanently discards the commits): git push origin upstream/${defaultBranch}:refs/heads/${defaultBranch} -f`
      );

      p.log.warn('Divergent commits detected:');
      p.note(sections.join('\n\n'), '⚠️  Warning');

      throw new SyncDivergenceError(
        defaultBranch,
        originDivergence,
        publicDivergence
      );
    }

    // Capture the previous mirror tip BEFORE the force-push so
    // `applyMirrorPlusOneCommit` can read preserved files from it. After the
    // push, `origin/<defaultBranch>` (locally and remotely) points at the
    // upstream tree and the previous mirror state is no longer reachable
    // through that ref.
    const prevTipResult = await $({
      ...cwdOpt,
      reject: false,
    })`git rev-parse --verify origin/${defaultBranch}`;
    const previousMirrorTip =
      prevTipResult.exitCode === 0 ? prevTipResult.stdout.trim() : '';

    // Step 5: Push upstream default branch to origin (and public, in standard mode)
    s.start(
      noPublic
        ? `Syncing ${defaultBranch} to origin`
        : `Syncing ${defaultBranch} to origin and public`
    );

    await $(
      cwdOpt
    )`git push origin upstream/${defaultBranch}:refs/heads/${defaultBranch} --force-with-lease`;
    if (!noPublic) {
      await $(
        cwdOpt
      )`git push public upstream/${defaultBranch}:refs/heads/${defaultBranch} --force-with-lease`;
    }

    s.stop(noPublic ? 'Synced to origin' : 'Synced to all remotes');

    // Step 6: Enforce mirror "+1 commit" model. Runs when schedule is enabled
    // (writes the managed sync workflow + filters upstream workflows) OR when
    // preserve is non-empty (carries mirror-only files forward across sync).
    const scheduleActive = Boolean(
      scheduleConfig?.enabled && scheduleConfig.cron
    );
    if (scheduleActive || preserveList.length > 0) {
      s.start('Re-applying mirror "+1 commit"');
      await applyMirrorPlusOneCommit({
        defaultBranch,
        schedule:
          scheduleActive && scheduleConfig
            ? {
                cron: scheduleConfig.cron,
                mode: noPublic ? 'no-public' : 'standard',
              }
            : null,
        enabledWorkflows,
        disabledWorkflows,
        preserve: preserveList,
        previousMirrorTip,
        cwd: options?.cwd,
      });
      s.stop('Mirror "+1 commit" applied');
    }

    if (!quiet) {
      p.outro(
        noPublic
          ? `✨ Sync complete! origin/${defaultBranch} is now up to date with upstream/${defaultBranch}`
          : `✨ Sync complete! origin/${defaultBranch} and public/${defaultBranch} are now up to date with upstream/${defaultBranch}`
      );
    }
  } catch (error) {
    if (error instanceof SyncDivergenceError) {
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

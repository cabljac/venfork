import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  normalizePreservePath,
  preserveRemoveHint,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfigPatch,
} from '../config.js';
import { getDefaultBranch } from '../git.js';
import { applyConfigChange } from '../shared/config-change.js';
import { changedFilesInCommit } from '../shared/divergence.js';
import { hasManagedTrailer } from '../shared/managed-commit.js';
import { resolveCommit } from '../shared/mirror-commit.js';
import { netFetch } from '../shared/net.js';
import { assertPreserveEntriesAreFiles } from '../shared/preserve-entries.js';

/**
 * Which of `paths` origin's managed commit carries, and where that commit
 * is: `tip` when it is origin's tip, `buried` when user commits sit on top
 * of it. Null when no managed commit on origin carries any of them.
 */
async function managedCommitCarrying(
  repoDir: string,
  paths: string[]
): Promise<{
  where: 'tip' | 'buried';
  defaultBranch: string;
  carried: string[];
} | null> {
  await netFetch('upstream', repoDir);
  await netFetch('origin', repoDir);
  const defaultBranch = await getDefaultBranch('upstream', repoDir);
  const tip = await resolveCommit(
    `refs/remotes/origin/${defaultBranch}`,
    repoDir
  );
  const upstreamTip = await resolveCommit(
    `refs/remotes/upstream/${defaultBranch}`,
    repoDir
  );
  if (!tip || !upstreamTip) return null;
  const ahead = (
    await $({
      cwd: repoDir,
    })`git rev-list ${`${upstreamTip}..${tip}`}`
  ).stdout
    .split('\n')
    .filter(Boolean);
  for (const commit of ahead) {
    if (!(await hasManagedTrailer(commit, repoDir))) continue;
    const files = await changedFilesInCommit(commit, repoDir);
    const carried = paths.filter((entry) => files.includes(entry));
    if (carried.length > 0) {
      return {
        where: commit === tip ? 'tip' : 'buried',
        defaultBranch,
        carried,
      };
    }
  }
  return null;
}

/**
 * Writes a preserve-list change that drops `removed`. When origin's managed
 * commit still carries a dropped file, origin is re-stamped in the same step
 * so the managed commit never holds a file the list no longer names. When
 * user commits sit on top of that managed commit, only the config is
 * written and a warning says sync drops the file once origin is back in line.
 */
async function writeRemoval(
  repoDir: string,
  patch: VenforkConfigPatch,
  removed: string[]
): Promise<void> {
  const carrying = await managedCommitCarrying(repoDir, removed);
  if (carrying?.where === 'tip') {
    await applyConfigChange(repoDir, patch);
    return;
  }
  await updateVenforkConfig(repoDir, patch);
  if (carrying?.where === 'buried') {
    const names = carrying.carried.map((entry) => `'${entry}'`).join(', ');
    p.log.warn(
      `origin/${carrying.defaultBranch} has diverged and its managed commit still carries ${names}. \`venfork sync\` drops it once the divergent commits are moved off origin/${carrying.defaultBranch}.`
    );
  }
}

/**
 * Preserve command: manage the `preserve` allowlist of mirror-only file paths
 * carried forward by `venfork sync`. Allowlist-only / opt-in: there's no
 * "deny preserve" concept (entries can still be added, removed, or cleared;
 * only the deny-direction has no semantics). Remove and clear re-stamp
 * origin's default branch when its managed commit carries a dropped file.
 */
export async function preserveCommand(
  action: 'list' | 'add' | 'remove' | 'clear',
  paths: string[]
): Promise<void> {
  p.intro('🧷 Venfork Preserve');
  const repoDir = process.cwd();

  try {
    if (action === 'list') {
      const config = await readVenforkConfigFromRepo(repoDir);
      if (!config) {
        throw new Error('venfork-config branch not found or invalid');
      }
      const entries = config.preserve ?? [];
      if (entries.length === 0) {
        p.note(
          'No files preserved. Sync will drop any mirror-only files on every run.',
          'Preserve Status'
        );
      } else {
        p.note(
          entries.map((entry) => `- ${entry}`).join('\n'),
          'Preserved files'
        );
      }
      const invalid = config.invalidPreserve ?? [];
      if (invalid.length > 0) {
        p.note(
          invalid
            .map((entry) => `- ${entry}: ${preserveRemoveHint(entry)}`)
            .join('\n'),
          'Invalid entries (sync refuses to run until they are removed)'
        );
      }
      p.outro('✨ Preserve list shown');
      return;
    }

    if (action === 'clear') {
      const config = await readVenforkConfigFromRepo(repoDir);
      await writeRemoval(repoDir, { preserve: null }, [
        ...(config?.preserve ?? []),
      ]);
      p.outro('✨ Preserve list cleared.');
      return;
    }

    const config = await readVenforkConfigFromRepo(repoDir);
    const current = [
      ...(config?.preserve ?? []),
      ...(config?.invalidPreserve ?? []),
    ];

    if (action === 'remove') {
      const toRemove = new Set(
        paths.map((entry) => normalizePreservePath(entry) ?? entry)
      );
      const filtered = current.filter((entry) => !toRemove.has(entry));
      await writeRemoval(
        repoDir,
        { preserve: filtered.length > 0 ? filtered : null },
        [...toRemove]
      );
      p.note(
        [...toRemove].map((entry) => `- ${entry}`).join('\n'),
        'Removed from preserve list'
      );
      p.outro('✨ Preserve list updated.');
      return;
    }

    const validated: string[] = [];
    for (const candidate of paths) {
      const cleaned = normalizePreservePath(candidate);
      if (!cleaned) {
        throw new Error(
          `Invalid preserve path '${candidate}': must be a clean relative path (no leading '/' or '-', no '..' / '.' / empty segments, no backslashes, NUL bytes, Windows drive prefixes, whitespace, glob characters (* ? [ ]) or leading ':'), and not the venfork sync workflow or a path under .venfork/.`
        );
      }
      validated.push(cleaned);
    }

    await assertPreserveEntriesAreFiles(validated, repoDir);
    const merged = Array.from(new Set([...current, ...validated]));
    await updateVenforkConfig(repoDir, { preserve: merged });
    p.note(
      validated.map((entry) => `- ${entry}`).join('\n'),
      'Added to preserve list'
    );
    p.outro(
      '✨ Preserve list updated. Run `venfork sync` to apply on the private mirror default branch.'
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Preserve command failed');
    process.exit(1);
  }
}

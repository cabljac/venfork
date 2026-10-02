import * as p from '@clack/prompts';
import {
  normalizePreservePath,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
  type VenforkConfig,
  type VenforkConfigPatch,
} from '../config.js';
import { getDefaultBranch } from '../git.js';
import { applyConfigChange } from '../shared/config-change.js';
import { changedFilesInCommit } from '../shared/divergence.js';
import { hasManagedTrailer } from '../shared/managed-commit.js';
import { resolveCommit } from '../shared/mirror-commit.js';
import { netFetch } from '../shared/net.js';

/** True when origin's managed commit carries any of `paths`. */
async function managedCommitCarries(
  repoDir: string,
  paths: string[]
): Promise<boolean> {
  await netFetch('origin', repoDir);
  const defaultBranch = await getDefaultBranch('upstream', repoDir);
  const tip = await resolveCommit(`origin/${defaultBranch}`, repoDir);
  if (!tip || !(await hasManagedTrailer(tip, repoDir))) return false;
  const files = await changedFilesInCommit(tip, repoDir);
  return paths.some((entry) => files.includes(entry));
}

/**
 * Writes a preserve-list change that drops `removed`. When origin's managed
 * commit still carries a dropped file, origin is re-stamped in the same step
 * so the managed commit never holds a file the list no longer names.
 */
async function writeRemoval(
  repoDir: string,
  patch: VenforkConfigPatch,
  removed: string[]
): Promise<void> {
  if (await managedCommitCarries(repoDir, removed)) {
    await applyConfigChange(repoDir, patch, restorePreserve);
  } else {
    await updateVenforkConfig(repoDir, patch);
  }
}

function restorePreserve(current: VenforkConfig): VenforkConfigPatch {
  const previous = [
    ...(current.preserve ?? []),
    ...(current.invalidPreserve ?? []),
  ];
  return { preserve: previous.length > 0 ? previous : null };
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
            .map((entry) => `- ${entry}: venfork preserve remove ${entry}`)
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

    // action === 'add'
    const merged = Array.from(new Set([...current, ...validated]));
    await updateVenforkConfig(repoDir, { preserve: merged });
    p.note(
      validated.map((entry) => `- ${entry}`).join('\n'),
      'Added to preserve list'
    );
    p.outro(
      '✨ Preserve list updated. Commit the file(s) to the mirror default branch (if not already), then run `venfork sync`.'
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro('❌ Preserve command failed');
    process.exit(1);
  }
}

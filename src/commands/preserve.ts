import * as p from '@clack/prompts';
import {
  normalizePreservePath,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
} from '../config.js';

/**
 * Preserve command: manage the `preserve` allowlist of mirror-only file paths
 * carried forward by `venfork sync`. Allowlist-only / opt-in: there's no
 * "deny preserve" concept (entries can still be added, removed, or cleared
 * — only the deny-direction has no semantics).
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
      p.outro('✨ Preserve list shown');
      return;
    }

    if (action === 'clear') {
      await updateVenforkConfig(repoDir, { preserve: null });
      p.outro(
        '✨ Preserve list cleared. Run `venfork sync` to apply on the private mirror default branch.'
      );
      return;
    }

    const validated: string[] = [];
    for (const candidate of paths) {
      const cleaned = normalizePreservePath(candidate);
      if (!cleaned) {
        throw new Error(
          `Invalid preserve path '${candidate}': must be a clean relative path (no leading '/' or '-', no '..' / '.' / empty segments, no backslashes, NUL bytes, Windows drive prefixes, whitespace, glob characters (* ? [ ]) or leading ':').`
        );
      }
      validated.push(cleaned);
    }

    const current = (await readVenforkConfigFromRepo(repoDir))?.preserve ?? [];

    if (action === 'add') {
      const merged = Array.from(new Set([...current, ...validated]));
      await updateVenforkConfig(repoDir, { preserve: merged });
      p.note(
        validated.map((entry) => `- ${entry}`).join('\n'),
        'Added to preserve list'
      );
      p.outro(
        '✨ Preserve list updated. Commit the file(s) to the mirror default branch (if not already), then run `venfork sync`.'
      );
      return;
    }

    // action === 'remove'
    const toRemove = new Set(validated);
    const filtered = current.filter((entry) => !toRemove.has(entry));
    await updateVenforkConfig(repoDir, {
      preserve: filtered.length > 0 ? filtered : null,
    });
    p.note(
      validated.map((entry) => `- ${entry}`).join('\n'),
      'Removed from preserve list'
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

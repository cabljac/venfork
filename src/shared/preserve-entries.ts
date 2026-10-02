import { $ } from 'execa';
import { getDefaultBranch } from '../git.js';
import { netFetch } from './net.js';

const BLOB_MODES = new Set(['100644', '100755', '120000']);

/**
 * Refuses preserve entries that are not single files on `origin/<default>`.
 * A directory entry would let the stage gate miss every file under it, and
 * a missing path protects nothing.
 *
 * @param entries Normalized preserve paths to add.
 * @param cwd Mirror checkout.
 * @throws Error naming the first entry that is a directory, missing or not a file.
 */
export async function assertPreserveEntriesAreFiles(
  entries: readonly string[],
  cwd: string
): Promise<void> {
  await netFetch('origin', cwd);
  const defaultBranch = await getDefaultBranch('origin', cwd);
  const ref = `refs/remotes/origin/${defaultBranch}`;
  for (const entry of entries) {
    const result = await $({
      cwd,
      reject: false,
    })`git --literal-pathspecs ls-tree -z ${ref} -- ${entry}`;
    const found = result.stdout
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return {
          meta: line.slice(0, tab).split(' '),
          path: line.slice(tab + 1),
        };
      })
      .find((item) => item.path === entry);
    const mode = found?.meta[0];
    if (mode === undefined) {
      throw new Error(
        `Cannot preserve '${entry}': it does not exist on origin/${defaultBranch}. Commit the file to origin/${defaultBranch} first.`
      );
    }
    if (!BLOB_MODES.has(mode)) {
      const kind = found?.meta[1] === 'tree' ? 'a directory' : 'not a file';
      throw new Error(
        `Cannot preserve '${entry}': it is ${kind} on origin/${defaultBranch}. Preserve supports single files only; list each file instead.`
      );
    }
  }
}

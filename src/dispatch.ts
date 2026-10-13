import { syncCommand } from './commands.js';
import { parsePullCliArgs } from './pull-args.js';
import { parseStageCliArgs } from './stage-args.js';

const ALWAYS_GH = new Set(['setup', 'clone']);

/**
 * Whether `venfork <command> <args>` talks to GitHub through gh and must
 * fail fast when gh is not authenticated. `pull` needs gh once its arguments parse, so a usage error
 * is reported first. `stage` needs gh for
 * `stage issue` and when a branch stage opens an upstream PR (`--pr` /
 * `--draft`).
 */
export function requiresGhAuth(command: string, args: string[]): boolean {
  if (ALWAYS_GH.has(command)) return true;
  if (command === 'pull') {
    try {
      parsePullCliArgs(args);
      return true;
    } catch {
      return false;
    }
  }
  if (command === 'stage') {
    try {
      const parsed = parseStageCliArgs(args);
      return (
        parsed.kind === 'issue' || Boolean(parsed.createPr || parsed.draft)
      );
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The `syncMirror` callback for `setupCommand`: a quiet sync of the clone at
 * `cwd`, so setup prints its own outro and sync prints none.
 *
 * @param sync The sync command to call; tests pass a spy.
 */
export function setupSyncMirror(
  sync: typeof syncCommand = syncCommand
): (cwd: string) => Promise<void> {
  return (cwd) => sync(undefined, { cwd, quiet: true });
}

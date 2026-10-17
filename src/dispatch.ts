import { syncCommand } from './commands.js';
import {
  CommandExitError,
  MissingInputError,
  NotInRepositoryError,
  UsageError,
} from './errors.js';
import { parsePullCliArgs } from './pull-args.js';
import { parseStageCliArgs } from './stage-args.js';

const ALWAYS_GH = new Set(['setup', 'clone']);

const IN_MIRROR = new Set([
  'sync',
  'stage',
  'pull',
  'schedule',
  'workflows',
  'preserve',
]);

/**
 * Whether `venfork <command>` runs inside a mirror clone, so src/index.ts
 * reports a failure outside a git repository as `NotInRepositoryError`.
 * doctor is not listed: it reports that as its `repo` check.
 */
export function requiresRepository(command: string): boolean {
  return IN_MIRROR.has(command);
}

/**
 * The error to report for a failed `command`: a {@link NotInRepositoryError}
 * when the command runs in a mirror and `inRepository` says cwd is not a git
 * repository, else `error`. Usage and missing-input errors keep their exit 2.
 * Checked after the failure, so a usage error inside the command still comes
 * first.
 */
export async function outsideRepositoryError(
  command: string,
  error: unknown,
  inRepository: () => Promise<boolean>
): Promise<unknown> {
  if (!requiresRepository(command)) return error;
  const cause =
    error instanceof CommandExitError && error.cause !== undefined
      ? error.cause
      : error;
  if (cause instanceof UsageError || cause instanceof MissingInputError) {
    return error;
  }
  if (error instanceof CommandExitError && error.exitCode !== 1) return error;
  return (await inRepository()) ? error : new NotInRepositoryError();
}

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
  return async (cwd) => {
    await sync(undefined, { cwd, quiet: true });
  };
}

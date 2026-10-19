import type { PullPrResult } from './commands/pull-request.js';
import type { StageResult } from './commands/stage.js';
import { syncCommand } from './commands.js';
import { NotInRepositoryError } from './errors.js';
import { parsePullCliArgs } from './pull-args.js';
import { parseStageCliArgs } from './stage-args.js';

const ALWAYS_GH = new Set(['setup', 'clone']);

const IN_MIRROR = new Set([
  'sync',
  'stage',
  'pull',
  'schedule',
  'workflows',
  'keep',
]);

/**
 * Whether `venfork <command>` runs inside a mirror clone, so src/index.ts
 * checks for a git repository before it runs the command.
 * doctor is not listed: it reports that as its `repo` check.
 */
export function requiresRepository(command: string): boolean {
  return IN_MIRROR.has(command);
}

/**
 * Throws {@link NotInRepositoryError} when `command` runs in a mirror and
 * `inRepository` says cwd is not a git repository. src/index.ts calls it
 * after the arguments parse and gh auth, so a usage error still exits 2.
 */
export async function assertInRepository(
  command: string,
  inRepository: () => Promise<boolean>
): Promise<void> {
  if (requiresRepository(command) && !(await inRepository())) {
    throw new NotInRepositoryError();
  }
}

/**
 * Whether `venfork <command> <args>` talks to GitHub through gh and must
 * fail fast when gh is not authenticated. `pull` needs gh once its arguments parse, so a usage error
 * is reported first. `stage` needs gh for
 * `stage issue` and for a branch stage, which opens the upstream PR unless
 * `--no-pr`.
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

/** A finished command run whose result can report a partial failure. */
export type PartialOutcome =
  | { command: 'stage'; result: StageResult }
  | { command: 'pull pr'; result: PullPrResult; push: boolean };

/**
 * 1 when a command did part of its job and failed the rest, else 0: stage
 * pushed but could not open the PR, or a push to origin that was asked for
 * failed. The `--json` result still says what landed.
 */
export function partialFailureExitCode(outcome: PartialOutcome): 0 | 1 {
  switch (outcome.command) {
    case 'stage':
      return 'prAction' in outcome.result &&
        outcome.result.prAction === 'failed'
        ? 1
        : 0;
    case 'pull pr':
      return outcome.push && !outcome.result.pushed ? 1 : 0;
  }
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
    await sync({ cwd, quiet: true });
  };
}

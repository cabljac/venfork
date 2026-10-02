import { parseStageCliArgs } from './stage-args.js';

const ALWAYS_GH = new Set(['setup', 'clone', 'pull']);

/**
 * Whether `venfork <command> <args>` talks to GitHub through gh and must
 * fail fast when gh is not authenticated. `stage` needs gh for
 * `stage issue` and when a branch stage opens an upstream PR (`--pr` /
 * `--draft`).
 */
export function requiresGhAuth(command: string, args: string[]): boolean {
  if (ALWAYS_GH.has(command)) return true;
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

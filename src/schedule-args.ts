import type { ScheduleAuth } from './config.js';
import { scanArgs, unexpectedArgument } from './shared/args.js';

/** Parsed `venfork schedule ...` arguments. */
export type ParsedScheduleArgs = {
  action: 'status' | 'set' | 'disable';
  /** Cron expression; set only for `set`. */
  cron?: string;
  /** Auth mode from `--app` or `--token`; set only for `set`, absent keeps the current mode. */
  auth?: ScheduleAuth;
};

/** Usage line for `venfork schedule`. */
export const SCHEDULE_USAGE =
  'venfork schedule <status|set <cron> [--app|--token]|disable>';

/**
 * Parse `venfork schedule ...` argv after the `schedule` token. The cron
 * expression itself is validated by the command.
 */
export function parseScheduleCliArgs(args: string[]): ParsedScheduleArgs {
  const authFlags: string[] = [];
  const [action = 'status', ...rest] = scanArgs(args, SCHEDULE_USAGE, (arg) => {
    if (arg !== '--app' && arg !== '--token') return undefined;
    authFlags.push(arg);
    return 0;
  });

  if (action === 'status' || action === 'disable') {
    if (authFlags.length > 0) {
      throw new Error(
        `${authFlags[0]} applies only to 'schedule set'. Usage: ${SCHEDULE_USAGE}`
      );
    }
    if (rest.length > 0) throw unexpectedArgument(rest[0], SCHEDULE_USAGE);
    return { action };
  }
  if (action === 'set') {
    if (new Set(authFlags).size > 1) {
      throw new Error(
        `--app and --token cannot be used together. Usage: ${SCHEDULE_USAGE}`
      );
    }
    if (rest.length === 0) {
      throw new Error(`Missing cron expression. Usage: ${SCHEDULE_USAGE}`);
    }
    if (rest.length > 1) throw unexpectedArgument(rest[1], SCHEDULE_USAGE);
    const auth =
      authFlags[0] === '--app' ? 'app' : authFlags[0] ? 'token' : undefined;
    return { action, cron: rest[0], ...(auth ? { auth } : {}) };
  }
  throw new Error(
    `Unknown schedule action '${action}'. Usage: ${SCHEDULE_USAGE}`
  );
}

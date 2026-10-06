import { scanArgs, unexpectedArgument } from './shared/args.js';

/** Parsed `venfork schedule ...` arguments. */
export type ParsedScheduleArgs = {
  action: 'status' | 'set' | 'disable';
  /** Cron expression; set only for `set`. */
  cron?: string;
};

/** Usage line for `venfork schedule`. */
export const SCHEDULE_USAGE = 'venfork schedule <status|set <cron>|disable>';

/**
 * Parse `venfork schedule ...` argv after the `schedule` token. The cron
 * expression itself is validated by the command.
 */
export function parseScheduleCliArgs(args: string[]): ParsedScheduleArgs {
  const [action = 'status', ...rest] = scanArgs(
    args,
    SCHEDULE_USAGE,
    () => undefined
  );

  if (action === 'status' || action === 'disable') {
    if (rest.length > 0) throw unexpectedArgument(rest[0], SCHEDULE_USAGE);
    return { action };
  }
  if (action === 'set') {
    if (rest.length === 0) {
      throw new Error(`Missing cron expression. Usage: ${SCHEDULE_USAGE}`);
    }
    if (rest.length > 1) throw unexpectedArgument(rest[1], SCHEDULE_USAGE);
    return { action, cron: rest[0] };
  }
  throw new Error(
    `Unknown schedule action '${action}'. Usage: ${SCHEDULE_USAGE}`
  );
}

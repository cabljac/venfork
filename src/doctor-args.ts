import { NO_INPUT_FLAG, scanArgs, unexpectedArgument } from './shared/args.js';
import { JSON_FLAG } from './shared/json-output.js';

const USAGE = 'venfork doctor [--no-input] [--json]';

/** Parsed flags for `venfork doctor`. */
export type ParsedDoctorArgs = {
  /** Run the health checks (always true for `doctor`). */
  check: boolean;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

/**
 * Parse `venfork doctor [--json]` argv after the `doctor` token.
 */
export function parseDoctorCliArgs(args: string[]): ParsedDoctorArgs {
  let json = false;
  const positional = scanArgs(args, USAGE, (arg) => {
    if (arg === NO_INPUT_FLAG) return 0;
    if (arg !== JSON_FLAG) return undefined;
    json = true;
    return 0;
  });
  if (positional.length > 0) throw unexpectedArgument(positional[0], USAGE);
  return { check: true, json };
}

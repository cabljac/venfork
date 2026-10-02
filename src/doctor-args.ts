/** Parsed flags for `venfork doctor` and `venfork status`. */
export type ParsedDoctorArgs = {
  /** Run the health checks (always true for `doctor`). */
  check: boolean;
  /** Print the checks as JSON instead of a table. */
  json: boolean;
};

/**
 * Parse `venfork doctor [--json]` argv after the `doctor` token.
 */
export function parseDoctorCliArgs(args: string[]): ParsedDoctorArgs {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else {
      throw new Error(
        `Unknown option '${arg}'. Usage: venfork doctor [--json]`
      );
    }
  }
  return { check: true, json };
}

/**
 * Parse `venfork status [--check] [--json]` argv after the `status` token.
 * `--json` only applies together with `--check`.
 */
export function parseStatusCliArgs(args: string[]): ParsedDoctorArgs {
  let check = false;
  let json = false;
  for (const arg of args) {
    if (arg === '--check') {
      check = true;
    } else if (arg === '--json') {
      json = true;
    } else {
      throw new Error(
        `Unknown option '${arg}'. Usage: venfork status [--check] [--json]`
      );
    }
  }
  if (json && !check) {
    throw new Error(
      '--json requires --check. Usage: venfork status --check --json'
    );
  }
  return { check, json };
}

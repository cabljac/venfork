/** Parsed flags for `venfork doctor`. */
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

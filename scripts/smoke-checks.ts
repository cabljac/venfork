/** Doctor check ids, in order, for a healthy fixture with a failing `gh` stub. */
export const EXPECTED_DOCTOR_IDS = [
  'repo',
  'remotes',
  'mode',
  'invariant',
  'divergence',
  'preserve',
  'workflow',
  'token',
  'last-run',
  'cron-age',
];

/**
 * Validates `doctor --json` output from the smoke run. Returns a problem
 * description, or null when the exit code, ids and results are as expected.
 */
export function verifyDoctorOutput(
  exitCode: number | undefined,
  stdout: string
): string | null {
  let checks: Array<{ id?: string; ok?: unknown }>;
  try {
    checks = JSON.parse(stdout)?.checks;
  } catch {
    return `doctor --json did not print JSON:\n${stdout}`;
  }
  if (exitCode !== 0) return `doctor exited with exit code ${exitCode}`;
  if (!Array.isArray(checks))
    return `doctor output has no checks array: ${stdout}`;
  const ids = checks.map((c) => c.id);
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED_DOCTOR_IDS)) {
    return `unexpected check ids: ${ids.join(',')}; want ${EXPECTED_DOCTOR_IDS.join(',')}`;
  }
  const failed = checks.filter((c) => c.ok !== true).map((c) => c.id);
  if (failed.length > 0) return `failing checks: ${failed.join(',')}`;
  return null;
}

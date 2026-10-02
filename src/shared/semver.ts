const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Compares two semantic versions. Returns a negative number when `a` is
 * older, positive when newer, 0 when equal, or null when either does not
 * parse. A prerelease sorts before its release; prerelease identifiers
 * compare numerically when both are numbers, else as strings.
 */
export function compareSemver(a: string, b: string): number | null {
  const ma = a.trim().match(SEMVER_RE);
  const mb = b.trim().match(SEMVER_RE);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return diff;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined || pb === undefined) {
    if (pa === pb) return 0;
    return pa === undefined ? 1 : -1;
  }
  const ia = pa.split('.');
  const ib = pb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      if (nx !== null) return -1;
      if (ny !== null) return 1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** The venfork version a generated sync workflow pins, or null. */
export function pinnedVenforkVersion(workflowYaml: string): string | null {
  return (
    workflowYaml.match(/venfork@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ??
    null
  );
}

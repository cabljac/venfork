const EXTRA_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'GITHUB_TOKEN'];
const ISOLATED_PREFIXES = ['GIT_', 'GH_', 'VENFORK_'];

/** True for a variable the fixture hides from git, gh and venfork. */
export function isolatedKey(key: string): boolean {
  return (
    ISOLATED_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    EXTRA_KEYS.includes(key)
  );
}

/**
 * Removes every `GIT_*`, `GH_*` and `VENFORK_*` variable plus HOME,
 * XDG_CONFIG_HOME and GITHUB_TOKEN from `process.env`, then applies
 * `overrides`. The returned function restores the exact previous values of
 * every isolated and overridden key. Nested calls must be restored in
 * reverse order (last isolated, first restored).
 */
export function isolateGitEnv(overrides: Record<string, string>): () => void {
  const touched = (key: string) => isolatedKey(key) || key in overrides;
  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (touched(key) && value !== undefined) snapshot.set(key, value);
  }
  for (const key of Object.keys(process.env)) {
    if (isolatedKey(key)) delete process.env[key];
  }
  Object.assign(process.env, overrides);

  return () => {
    for (const key of Object.keys(process.env)) {
      if (touched(key)) delete process.env[key];
    }
    for (const [key, value] of snapshot) {
      process.env[key] = value;
    }
  };
}

/** A copy of `process.env` without any isolated key, for spawning git. */
export function envWithoutIsolatedKeys(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isolatedKey(key)) env[key] = value;
  }
  return env;
}

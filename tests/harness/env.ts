const EXTRA_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'GH_TOKEN', 'GITHUB_TOKEN'];

function isolatedKey(key: string): boolean {
  return key.startsWith('GIT_') || EXTRA_KEYS.includes(key);
}

/**
 * Removes every `GIT_*` variable plus HOME, XDG_CONFIG_HOME, GH_TOKEN and
 * GITHUB_TOKEN from `process.env`, then applies `overrides`. The returned
 * function restores the exact previous values. Nested calls must be
 * restored in reverse order (last isolated, first restored).
 */
export function isolateGitEnv(overrides: Record<string, string>): () => void {
  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (isolatedKey(key) && value !== undefined) snapshot.set(key, value);
  }
  for (const key of Object.keys(process.env)) {
    if (isolatedKey(key)) delete process.env[key];
  }
  Object.assign(process.env, overrides);

  return () => {
    for (const key of Object.keys(process.env)) {
      if (isolatedKey(key)) delete process.env[key];
    }
    for (const [key, value] of snapshot) {
      process.env[key] = value;
    }
  };
}

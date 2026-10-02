import type { MirrorFixture } from './mirror-fixture.js';

/**
 * Adds `entries` to the preserve allowlist in the fixture's config without
 * `venfork preserve add`, which only accepts files already on origin's
 * default branch. Tests use it to set up a list before the files exist.
 */
export async function seedPreserve(
  fx: MirrorFixture,
  entries: string[]
): Promise<void> {
  const config = await fx.readRawConfig();
  const current = Array.isArray(config.preserve)
    ? (config.preserve as string[])
    : [];
  await fx.writeRawConfig(
    JSON.stringify({
      ...config,
      preserve: [...new Set([...current, ...entries])],
    })
  );
}

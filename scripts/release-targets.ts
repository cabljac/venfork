/** Binaries built by the release job, one per Bun compile target. */
export const RELEASE_TARGETS: { bunTarget: string; platform: string }[] = [
  { bunTarget: 'bun-darwin-arm64', platform: 'darwin-arm64' },
  { bunTarget: 'bun-darwin-x64', platform: 'darwin-x64' },
  { bunTarget: 'bun-linux-x64', platform: 'linux-x64' },
  { bunTarget: 'bun-linux-arm64', platform: 'linux-arm64' },
  { bunTarget: 'bun-windows-x64', platform: 'win32-x64' },
];

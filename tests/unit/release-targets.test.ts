import { expect, test } from 'bun:test';
import { RELEASE_TARGETS } from '../../scripts/release-targets';

test('release targets are the platforms the pinned Bun can compile', () => {
  expect(RELEASE_TARGETS.map((t) => t.bunTarget)).toEqual([
    'bun-darwin-arm64',
    'bun-darwin-x64',
    'bun-linux-x64',
    'bun-linux-arm64',
    'bun-windows-x64',
  ]);
});

test('release targets have unique platform names', () => {
  const platforms = RELEASE_TARGETS.map((t) => t.platform);
  expect(new Set(platforms).size).toBe(platforms.length);
});

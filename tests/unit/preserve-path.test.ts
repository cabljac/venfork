import { describe, expect, test } from 'bun:test';
import { normalizePreservePath } from '../../src/config.js';

describe('normalizePreservePath', () => {
  test.each([
    ['.github/workflows/caller.yml'],
    ['scripts/release.sh'],
    ['docs/MIRROR.md'],
  ])('accepts the literal path %s', (value) => {
    expect(normalizePreservePath(value)).toBe(value);
  });

  test.each([
    ['star glob', 'src/file-*.txt'],
    ['question-mark glob', 'src/file-?.txt'],
    ['bracket glob', 'src/file-[12].txt'],
    ['closing bracket', 'src/file-1].txt'],
    ['exclude magic', ':!nothing'],
    ['literal magic', ':(literal)a.txt'],
    ['top magic', ':/a.txt'],
    ['backslash', 'src\\a.txt'],
    ['leading slash', '/etc/passwd'],
    ['leading dash', '--all'],
    ['parent segment', 'a/../b'],
    ['whitespace', 'a b'],
    ['the sync workflow', '.github/workflows/venfork-sync.yml'],
    ['a path below the sync workflow', '.github/workflows/venfork-sync.yml/x'],
    ['the venfork config', '.venfork/config.json'],
    ['the venfork directory', '.venfork'],
  ])('rejects %s (%s)', (_label, value) => {
    expect(normalizePreservePath(value)).toBeNull();
  });
});

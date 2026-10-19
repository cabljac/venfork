import { describe, expect, test } from 'bun:test';
import { errorText } from '../../src/errors.js';
import {
  divergenceError,
  PRESERVE_COMMAND_MAX_FILES,
  preserveCommandFor,
} from '../../src/shared/divergence.js';

describe('preserveCommandFor', () => {
  test('preserveCommandFor shell-quotes each path', () => {
    expect(
      preserveCommandFor([
        'docs/INTERNAL.md',
        'notes$(id>PWNED).md',
        "it's.md",
        'a;b`c`.md',
      ])
    ).toBe(
      "venfork preserve add 'docs/INTERNAL.md' 'notes$(id>PWNED).md' 'it'\\''s.md' 'a;b`c`.md'"
    );
  });

  test('preserveCommandFor leaves out paths the preserve list refuses', () => {
    expect(preserveCommandFor(['ok.md', 'has space.md', '*.md'])).toBe(
      "venfork preserve add 'ok.md'"
    );
    expect(preserveCommandFor(['*.md'])).toBeUndefined();
  });

  test('preserveCommandFor gives no command above PRESERVE_COMMAND_MAX_FILES files', () => {
    const files = (count: number) =>
      Array.from({ length: count }, (_, i) => `gen/file-${i}.txt`);
    expect(preserveCommandFor(files(PRESERVE_COMMAND_MAX_FILES))).toBeDefined();
    expect(
      preserveCommandFor(files(PRESERVE_COMMAND_MAX_FILES + 1))
    ).toBeUndefined();
  });
});

describe('divergenceError', () => {
  test('a divergence of 2000 files keeps the hint short and the full list in details', () => {
    const files = Array.from({ length: 2000 }, (_, i) => `gen/file-${i}.txt`);
    const error = divergenceError(
      'main',
      { count: 1, files },
      { count: 0, files: [] }
    );
    expect(errorText(error).length).toBeLessThan(400);
    expect(error.details).not.toHaveProperty('command');
    expect(error.details?.origin).toEqual({ count: 1, files });
  });

  test('the hint asks to retry, not to sync, so it fits every command that checks divergence', () => {
    for (const files of [['docs/INTERNAL.md'], ['*.md']]) {
      const error = divergenceError(
        'main',
        { count: 1, files },
        { count: 0, files: [] }
      );
      expect(error.hint).toMatch(/move the commits to a branch and retry/i);
      expect(error.hint).not.toContain('sync again');
    }
  });
});

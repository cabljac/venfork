import { describe, expect, test } from 'bun:test';
import { errorText } from '../../src/errors.js';
import {
  divergenceError,
  formatDivergenceReport,
  KEEP_COMMAND_MAX_FILES,
  keepCommandFor,
} from '../../src/shared/divergence.js';

describe('keepCommandFor', () => {
  test('keepCommandFor shell-quotes each path', () => {
    expect(
      keepCommandFor([
        'docs/INTERNAL.md',
        'notes$(id>PWNED).md',
        "it's.md",
        'a;b`c`.md',
      ])
    ).toBe(
      "venfork keep add 'docs/INTERNAL.md' 'notes$(id>PWNED).md' 'it'\\''s.md' 'a;b`c`.md'"
    );
  });

  test('keepCommandFor leaves out paths the preserve list refuses', () => {
    expect(keepCommandFor(['ok.md', 'has space.md', '*.md'])).toBe(
      "venfork keep add 'ok.md'"
    );
    expect(keepCommandFor(['*.md'])).toBeUndefined();
  });

  test('keepCommandFor gives no command above KEEP_COMMAND_MAX_FILES files', () => {
    const files = (count: number) =>
      Array.from({ length: count }, (_, i) => `gen/file-${i}.txt`);
    expect(keepCommandFor(files(KEEP_COMMAND_MAX_FILES))).toBeDefined();
    expect(keepCommandFor(files(KEEP_COMMAND_MAX_FILES + 1))).toBeUndefined();
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

describe('formatDivergenceReport', () => {
  test('names the paths it left out of the keep hint', () => {
    const report = formatDivergenceReport(
      divergenceError(
        'main',
        { count: 1, files: ['ok.md', 'has space.md'] },
        { count: 0, files: [] }
      )
    );
    expect(report).toContain("venfork keep add 'ok.md'");
    expect(report).toContain(
      '(left out of the hint because the keep list cannot hold them: has space.md)'
    );
  });
});

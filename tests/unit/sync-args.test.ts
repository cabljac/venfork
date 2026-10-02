import { describe, expect, test } from 'bun:test';
import { parseSyncCliArgs } from '../../src/sync-args.js';

describe('parseSyncCliArgs', () => {
  test('no arguments syncs the default branch', () => {
    expect(parseSyncCliArgs([])).toEqual({
      branch: undefined,
      reportIssues: false,
    });
  });

  test('branch and --report-issues in any order', () => {
    expect(parseSyncCliArgs(['--report-issues', 'develop'])).toEqual({
      branch: 'develop',
      reportIssues: true,
    });
  });

  test('rejects unknown options and extra branches', () => {
    expect(() => parseSyncCliArgs(['--force'])).toThrow(
      "Unknown option '--force'"
    );
    expect(() => parseSyncCliArgs(['a', 'b'])).toThrow('Usage: venfork sync');
  });
});

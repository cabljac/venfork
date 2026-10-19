import { describe, expect, test } from 'bun:test';
import { parseSyncCliArgs } from '../../src/sync-args.js';

describe('parseSyncCliArgs', () => {
  test('no arguments syncs the default branch', () => {
    expect(parseSyncCliArgs([])).toEqual({
      reportIssues: false,
      json: false,
    });
  });

  test('reads --report-issues and --json', () => {
    expect(parseSyncCliArgs(['--report-issues', '--json'])).toEqual({
      reportIssues: true,
      json: true,
    });
  });

  test('rejects unknown options', () => {
    expect(() => parseSyncCliArgs(['--force'])).toThrow(
      "Unknown option '--force'"
    );
  });

  test('a branch is a usage error that points at pull pr', () => {
    expect(() => parseSyncCliArgs(['develop'])).toThrow(
      "venfork sync takes no branch ('develop')"
    );
    expect(() => parseSyncCliArgs(['develop'])).toThrow(
      'run `venfork pull pr <n>` again'
    );
    expect(() => parseSyncCliArgs(['upstream-pr/12', '--json'])).toThrow(
      'run `venfork pull pr 12` again'
    );
  });
});

describe('parseSyncCliArgs and --', () => {
  test('-- ends options, and a positional after it is still refused', () => {
    expect(parseSyncCliArgs(['--json', '--'])).toEqual({
      reportIssues: false,
      json: true,
    });
    expect(() => parseSyncCliArgs(['--report-issues', '--', '-weird'])).toThrow(
      "venfork sync takes no branch ('-weird')"
    );
  });
});

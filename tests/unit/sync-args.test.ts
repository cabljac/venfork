import { describe, expect, test } from 'bun:test';
import { parseSyncCliArgs } from '../../src/sync-args.js';

describe('parseSyncCliArgs', () => {
  test('no arguments syncs the default branch', () => {
    expect(parseSyncCliArgs([])).toEqual({
      branch: undefined,
      reportIssues: false,
      json: false,
    });
  });

  test('branch and --report-issues in any order', () => {
    expect(parseSyncCliArgs(['--report-issues', 'develop'])).toEqual({
      branch: 'develop',
      reportIssues: true,
      json: false,
    });
  });

  test('reads --json', () => {
    expect(parseSyncCliArgs(['main', '--json'])).toEqual({
      branch: 'main',
      reportIssues: false,
      json: true,
    });
  });

  test('rejects unknown options and extra branches', () => {
    expect(() => parseSyncCliArgs(['--force'])).toThrow(
      "Unknown option '--force'"
    );
    expect(() => parseSyncCliArgs(['a', 'b'])).toThrow('Usage: venfork sync');
  });
});

describe('parseSyncCliArgs and --', () => {
  test('-- ends options, so a dash-leading branch can follow it', () => {
    expect(parseSyncCliArgs(['--json', '--'])).toEqual({
      branch: undefined,
      reportIssues: false,
      json: true,
    });
    expect(parseSyncCliArgs(['--report-issues', '--', '-weird'])).toEqual({
      branch: '-weird',
      reportIssues: true,
      json: false,
    });
  });
});

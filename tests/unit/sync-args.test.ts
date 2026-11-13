import { describe, expect, test } from 'bun:test';
import { parseSyncCliArgs } from '../../src/sync-args.js';

describe('parseSyncCliArgs', () => {
  test('no arguments syncs the default branch', () => {
    expect(parseSyncCliArgs([])).toEqual({
      reportIssues: false,
      json: false,
      acceptRewrites: [],
    });
  });

  test('reads --report-issues and --json', () => {
    expect(parseSyncCliArgs(['--report-issues', '--json'])).toEqual({
      reportIssues: true,
      json: true,
      acceptRewrites: [],
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
      acceptRewrites: [],
    });
    expect(() => parseSyncCliArgs(['--report-issues', '--', '-weird'])).toThrow(
      "venfork sync takes no branch ('-weird')"
    );
  });
});

describe('parseSyncCliArgs --accept-rewrite', () => {
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);

  test('reads each accepted rewrite, in both flag forms', () => {
    expect(
      parseSyncCliArgs([
        '--accept-rewrite',
        `ga=${OLD}..${NEW}`,
        `--accept-rewrite=release/1.x=${NEW}..${OLD}`,
      ]).acceptRewrites
    ).toEqual([
      { branch: 'ga', from: OLD, to: NEW },
      { branch: 'release/1.x', from: NEW, to: OLD },
    ]);
  });

  test('rewrite acceptance rejects reserved HEAD and revision expressions', () => {
    for (const branch of ['HEAD', 'ga~1', 'ga^', 'a..b']) {
      expect(() =>
        parseSyncCliArgs(['--accept-rewrite', `${branch}=${OLD}..${NEW}`])
      ).toThrow('literal branch name');
    }
    expect(
      parseSyncCliArgs(['--accept-rewrite', `release/HEAD=${OLD}..${NEW}`])
        .acceptRewrites[0].branch
    ).toBe('release/HEAD');
  });

  test('refuses abbreviated ids, a missing range and a missing branch', () => {
    for (const value of [
      `ga=${OLD.slice(0, 12)}..${NEW}`,
      `ga=${OLD}`,
      `=${OLD}..${NEW}`,
      `ga=${OLD}...${NEW}`,
    ]) {
      expect(() => parseSyncCliArgs(['--accept-rewrite', value])).toThrow(
        '--accept-rewrite takes <branch>=<old>..<new> with full lowercase commit ids'
      );
    }
  });

  test('refuses the same branch twice and a missing value', () => {
    expect(() =>
      parseSyncCliArgs([
        '--accept-rewrite',
        `ga=${OLD}..${NEW}`,
        '--accept-rewrite',
        `ga=${NEW}..${OLD}`,
      ])
    ).toThrow("--accept-rewrite names 'ga' twice");
    expect(() => parseSyncCliArgs(['--accept-rewrite'])).toThrow(
      '--accept-rewrite requires a value'
    );
  });
});

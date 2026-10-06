import { describe, expect, test } from 'bun:test';
import {
  type ParsedPullIssueArgs,
  type ParsedPullPrArgs,
  parsePullCliArgs,
} from '../../src/pull-args.js';

function parsePr(args: string[]): ParsedPullPrArgs {
  const parsed = parsePullCliArgs(['pr', ...args]);
  if (parsed.kind !== 'pr') throw new Error('expected a pr parse');
  return parsed;
}

function parseIssue(args: string[]): ParsedPullIssueArgs {
  const parsed = parsePullCliArgs(['issue', ...args]);
  if (parsed.kind !== 'issue') throw new Error('expected an issue parse');
  return parsed;
}

describe('parsePullCliArgs pr', () => {
  test('parses positional pr number', () => {
    const parsed = parsePr(['1234']);
    expect(parsed.ref).toBe('1234');
    expect(parsed.push).toBe(true);
    expect(parsed.branchName).toBeUndefined();
  });

  test('parses positional pr URL', () => {
    const parsed = parsePr(['https://github.com/owner/repo/pull/42']);
    expect(parsed.ref).toBe('https://github.com/owner/repo/pull/42');
  });

  test('--no-push opts out of pushing to mirror', () => {
    expect(parsePr(['42', '--no-push']).push).toBe(false);
  });

  test('--branch-name value form', () => {
    const parsed = parsePr(['42', '--branch-name', 'review/upstream-42']);
    expect(parsed.branchName).toBe('review/upstream-42');
  });

  test('--branch-name= form', () => {
    const parsed = parsePr(['42', '--branch-name=review/upstream-42']);
    expect(parsed.branchName).toBe('review/upstream-42');
  });

  test('throws when --branch-name has no value', () => {
    expect(() => parsePr(['42', '--branch-name'])).toThrow(
      '--branch-name requires a value'
    );
  });

  test('a missing ref throws a usage error', () => {
    expect(() => parsePr([])).toThrow(
      'Missing PR number or URL. Usage: venfork pull pr'
    );
    expect(() => parsePr(['--no-push'])).toThrow('Missing PR number or URL');
    expect(() => parseIssue([])).toThrow(
      'Missing issue number or URL. Usage: venfork pull issue'
    );
  });
});

describe('parsePullCliArgs issue', () => {
  test('parses `issue <n>`', () => {
    expect(parseIssue(['1234'])).toEqual({
      kind: 'issue',
      ref: '1234',
      title: undefined,
    });
  });

  test('parses --title value form', () => {
    expect(parseIssue(['7', '--title', 'Override']).title).toBe('Override');
  });

  test('parses --title= form', () => {
    expect(parseIssue(['7', '--title=Override']).title).toBe('Override');
  });

  test('throws when --title has no value', () => {
    expect(() => parseIssue(['7', '--title'])).toThrow(
      '--title requires a value'
    );
  });
});

describe('parsePullCliArgs targets', () => {
  test('throws on an unknown target', () => {
    expect(() => parsePullCliArgs(['burn', '7'])).toThrow(
      'Unknown pull target: burn'
    );
  });

  test('throws with usage when the target is missing', () => {
    expect(() => parsePullCliArgs([])).toThrow('Usage: venfork pull');
    expect(() => parsePullCliArgs(['--no-push'])).toThrow(
      'Usage: venfork pull'
    );
  });

  test('a bare number is not a target', () => {
    expect(() => parsePullCliArgs(['1234'])).toThrow('Unknown pull target');
  });
});

describe('parsePullCliArgs strictness', () => {
  test('rejects unknown flags in both forms', () => {
    expect(() => parsePullCliArgs(['pr', '5', '--bogus'])).toThrow(
      "Unknown option '--bogus'. Usage: venfork pull pr"
    );
    expect(() => parsePullCliArgs(['issue', '5', '--bogus'])).toThrow(
      "Unknown option '--bogus'. Usage: venfork pull issue"
    );
  });

  test('flags of the other form are unknown', () => {
    expect(() => parsePullCliArgs(['pr', '5', '--title', 'x'])).toThrow(
      "Unknown option '--title'"
    );
    expect(() => parsePullCliArgs(['issue', '5', '--no-push'])).toThrow(
      "Unknown option '--no-push'"
    );
  });

  test('a flag before the ref is not taken as the ref', () => {
    expect(parsePr(['--no-push', '5'])).toMatchObject({
      ref: '5',
      push: false,
    });
    expect(parseIssue(['--title=T', '5'])).toMatchObject({
      ref: '5',
      title: 'T',
    });
    expect(parsePr(['--branch-name', 'b', '5']).ref).toBe('5');
  });

  test('flags are accepted before the subcommand', () => {
    expect(parsePullCliArgs(['--no-push', 'pr', '5'])).toMatchObject({
      kind: 'pr',
      ref: '5',
      push: false,
    });
    expect(parsePullCliArgs(['--title', 'T', 'issue', '5'])).toMatchObject({
      kind: 'issue',
      ref: '5',
      title: 'T',
    });
  });

  test('-- ends options', () => {
    expect(parsePr(['--', '5']).ref).toBe('5');
  });

  test('rejects an extra positional', () => {
    expect(() => parsePullCliArgs(['pr', '5', '6'])).toThrow(
      "Unexpected argument '6'. Usage: venfork pull pr"
    );
    expect(() => parsePullCliArgs(['issue', '5', '6'])).toThrow(
      "Unexpected argument '6'"
    );
  });

  test('missing value at the end of argv throws', () => {
    expect(() => parsePullCliArgs(['pr', '5', '--branch-name'])).toThrow(
      '--branch-name requires a value'
    );
    expect(() => parsePullCliArgs(['issue', '5', '--title'])).toThrow(
      '--title requires a value'
    );
  });

  test('--flag=value form works for both', () => {
    expect(parsePr(['5', '--branch-name=b']).branchName).toBe('b');
    expect(parseIssue(['5', '--title=T']).title).toBe('T');
  });
});

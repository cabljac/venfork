import { describe, expect, test } from 'bun:test';
import { parsePullRequestCliArgs } from '../src/pull-request-args.js';

describe('parsePullRequestCliArgs', () => {
  test('parses positional pr number', () => {
    const parsed = parsePullRequestCliArgs(['1234']);
    expect(parsed.pr).toBe('1234');
    expect(parsed.push).toBe(true);
    expect(parsed.branchName).toBeUndefined();
  });

  test('parses positional pr URL', () => {
    const parsed = parsePullRequestCliArgs([
      'https://github.com/owner/repo/pull/42',
    ]);
    expect(parsed.pr).toBe('https://github.com/owner/repo/pull/42');
  });

  test('--no-push opts out of pushing to mirror', () => {
    const parsed = parsePullRequestCliArgs(['42', '--no-push']);
    expect(parsed.push).toBe(false);
  });

  test('--branch-name value form', () => {
    const parsed = parsePullRequestCliArgs([
      '42',
      '--branch-name',
      'review/upstream-42',
    ]);
    expect(parsed.branchName).toBe('review/upstream-42');
  });

  test('--branch-name= form', () => {
    const parsed = parsePullRequestCliArgs([
      '42',
      '--branch-name=review/upstream-42',
    ]);
    expect(parsed.branchName).toBe('review/upstream-42');
  });

  test('throws when --branch-name has no value', () => {
    expect(() => parsePullRequestCliArgs(['42', '--branch-name'])).toThrow(
      '--branch-name requires a value'
    );
  });
});

import { describe, expect, test } from 'bun:test';
import { parseIssueCliArgs } from '../src/issue-args.js';

describe('parseIssueCliArgs', () => {
  test('parses `stage <n>`', () => {
    const parsed = parseIssueCliArgs(['stage', '7']);
    expect(parsed.action).toBe('stage');
    expect(parsed.target).toBe('7');
    expect(parsed.title).toBeUndefined();
  });

  test('parses `pull <n>`', () => {
    const parsed = parseIssueCliArgs(['pull', '1234']);
    expect(parsed.action).toBe('pull');
    expect(parsed.target).toBe('1234');
  });

  test('parses --title value form', () => {
    const parsed = parseIssueCliArgs(['stage', '7', '--title', 'Override']);
    expect(parsed.title).toBe('Override');
  });

  test('parses --title= form', () => {
    const parsed = parseIssueCliArgs(['stage', '7', '--title=Override']);
    expect(parsed.title).toBe('Override');
  });

  test('throws on unknown action', () => {
    expect(() => parseIssueCliArgs(['burn', '7'])).toThrow(
      'Unknown issue action'
    );
  });

  test('throws when --title has no value', () => {
    expect(() => parseIssueCliArgs(['stage', '7', '--title'])).toThrow(
      '--title requires a value'
    );
  });
});

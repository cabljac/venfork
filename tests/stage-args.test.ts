import { describe, expect, test } from 'bun:test';
import { parseStageCliArgs } from '../src/stage-args.js';

describe('parseStageCliArgs', () => {
  test('parses positional branch with no flags', () => {
    const parsed = parseStageCliArgs(['feat/auth']);
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.createPr).toBe(false);
    expect(parsed.draft).toBe(false);
    expect(parsed.title).toBeUndefined();
    expect(parsed.base).toBeUndefined();
  });

  test('--pr opts in to upstream PR creation', () => {
    const parsed = parseStageCliArgs(['feat/auth', '--pr']);
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.createPr).toBe(true);
    expect(parsed.draft).toBe(false);
  });

  test('--draft implies --pr', () => {
    const parsed = parseStageCliArgs(['feat/auth', '--draft']);
    expect(parsed.createPr).toBe(true);
    expect(parsed.draft).toBe(true);
  });

  test('parses --title and --base value forms', () => {
    const parsed = parseStageCliArgs([
      'feat/auth',
      '--pr',
      '--title',
      'Add auth',
      '--base',
      'develop',
    ]);
    expect(parsed.title).toBe('Add auth');
    expect(parsed.base).toBe('develop');
  });

  test('parses --title= and --base= forms', () => {
    const parsed = parseStageCliArgs([
      'feat/auth',
      '--pr',
      '--title=Add auth',
      '--base=develop',
    ]);
    expect(parsed.title).toBe('Add auth');
    expect(parsed.base).toBe('develop');
  });

  test('throws when --title has no value', () => {
    expect(() => parseStageCliArgs(['feat/auth', '--pr', '--title'])).toThrow(
      '--title requires a value'
    );
  });

  test('throws when --title= is empty', () => {
    expect(() => parseStageCliArgs(['feat/auth', '--pr', '--title='])).toThrow(
      '--title requires a value'
    );
  });

  test('throws when --base has no value', () => {
    expect(() => parseStageCliArgs(['feat/auth', '--pr', '--base'])).toThrow(
      '--base requires a value'
    );
  });

  test('flag order does not matter; positional can come last', () => {
    const parsed = parseStageCliArgs(['--pr', '--draft', 'feat/auth']);
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.createPr).toBe(true);
    expect(parsed.draft).toBe(true);
  });
});

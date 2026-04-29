import { describe, expect, test } from 'bun:test';
import { parsePreserveCliArgs } from '../src/preserve-args.js';

describe('parsePreserveCliArgs', () => {
  test('defaults to list', () => {
    expect(parsePreserveCliArgs([])).toEqual({
      action: 'list',
      paths: [],
    });
  });

  test('parses list explicitly', () => {
    expect(parsePreserveCliArgs(['list'])).toEqual({
      action: 'list',
      paths: [],
    });
  });

  test('parses add with multiple paths', () => {
    expect(
      parsePreserveCliArgs([
        'add',
        '.github/workflows/caller.yml',
        'docs/MIRROR.md',
      ])
    ).toEqual({
      action: 'add',
      paths: ['.github/workflows/caller.yml', 'docs/MIRROR.md'],
    });
  });

  test('parses remove with multiple paths', () => {
    expect(
      parsePreserveCliArgs(['remove', '.github/workflows/caller.yml'])
    ).toEqual({
      action: 'remove',
      paths: ['.github/workflows/caller.yml'],
    });
  });

  test('parses clear', () => {
    expect(parsePreserveCliArgs(['clear'])).toEqual({
      action: 'clear',
      paths: [],
    });
  });

  test('does not split paths on commas', () => {
    expect(parsePreserveCliArgs(['add', 'a,b/c.yml'])).toEqual({
      action: 'add',
      paths: ['a,b/c.yml'],
    });
  });

  test('throws when add has no paths', () => {
    expect(() => parsePreserveCliArgs(['add'])).toThrow();
  });

  test('throws when remove has no paths', () => {
    expect(() => parsePreserveCliArgs(['remove'])).toThrow();
  });

  test('throws on unknown action', () => {
    expect(() => parsePreserveCliArgs(['nuke'])).toThrow();
  });
});

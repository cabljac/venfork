import { describe, expect, test } from 'bun:test';
import { parseKeepCliArgs } from '../../src/keep-args.js';

describe('parseKeepCliArgs', () => {
  test('defaults to list', () => {
    expect(parseKeepCliArgs([])).toEqual({
      action: 'list',
      paths: [],
      json: false,
    });
  });

  test('parses list explicitly', () => {
    expect(parseKeepCliArgs(['list'])).toEqual({
      action: 'list',
      paths: [],
      json: false,
    });
  });

  test('parses add with multiple paths', () => {
    expect(
      parseKeepCliArgs([
        'add',
        '.github/workflows/caller.yml',
        'docs/MIRROR.md',
      ])
    ).toEqual({
      action: 'add',
      paths: ['.github/workflows/caller.yml', 'docs/MIRROR.md'],
      json: false,
    });
  });

  test('parses remove with multiple paths', () => {
    expect(
      parseKeepCliArgs(['remove', '.github/workflows/caller.yml'])
    ).toEqual({
      action: 'remove',
      paths: ['.github/workflows/caller.yml'],
      json: false,
    });
  });

  test('parses clear', () => {
    expect(parseKeepCliArgs(['clear'])).toEqual({
      action: 'clear',
      paths: [],
      json: false,
    });
  });

  test('does not split paths on commas', () => {
    expect(parseKeepCliArgs(['add', 'a,b/c.yml'])).toEqual({
      action: 'add',
      paths: ['a,b/c.yml'],
      json: false,
    });
  });

  test('throws when add has no paths', () => {
    expect(() => parseKeepCliArgs(['add'])).toThrow();
  });

  test('throws when remove has no paths', () => {
    expect(() => parseKeepCliArgs(['remove'])).toThrow();
  });

  test('throws on unknown action', () => {
    expect(() => parseKeepCliArgs(['nuke'])).toThrow();
  });
});

describe('parseKeepCliArgs strictness', () => {
  test('rejects unknown flags instead of preserving them as paths', () => {
    expect(() => parseKeepCliArgs(['add', '--bogus'])).toThrow(
      "Unknown option '--bogus'. Usage: venfork keep"
    );
    expect(() => parseKeepCliArgs(['--bogus'])).toThrow(
      "Unknown option '--bogus'"
    );
  });

  test('rejects extra arguments to list and clear', () => {
    expect(() => parseKeepCliArgs(['list', 'extra'])).toThrow(
      "Unexpected argument 'extra'"
    );
    expect(() => parseKeepCliArgs(['clear', 'extra'])).toThrow(
      "Unexpected argument 'extra'"
    );
  });

  test('-- ends options so a dash-leading path is accepted', () => {
    expect(parseKeepCliArgs(['add', '--', '-odd.txt']).paths).toEqual([
      '-odd.txt',
    ]);
  });
});

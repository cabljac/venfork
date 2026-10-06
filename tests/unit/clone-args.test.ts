import { describe, expect, test } from 'bun:test';
import { parseCloneCliArgs } from '../../src/clone-args.js';

describe('parseCloneCliArgs', () => {
  test('parses bare positional vendor URL', () => {
    expect(parseCloneCliArgs(['git@github.com:acme/proj-private.git'])).toEqual(
      {
        vendorRepoUrl: 'git@github.com:acme/proj-private.git',
        noPublic: false,
        upstreamUrl: undefined,
      }
    );
  });

  test('--no-public sets the flag', () => {
    expect(parseCloneCliArgs(['acme/proj-private', '--no-public'])).toEqual({
      vendorRepoUrl: 'acme/proj-private',
      noPublic: true,
      upstreamUrl: undefined,
    });
  });

  test('--upstream value form', () => {
    expect(
      parseCloneCliArgs([
        'acme/proj-private',
        '--no-public',
        '--upstream',
        'git@github.com:acme/proj.git',
      ])
    ).toEqual({
      vendorRepoUrl: 'acme/proj-private',
      noPublic: true,
      upstreamUrl: 'git@github.com:acme/proj.git',
    });
  });

  test('--upstream= form', () => {
    expect(
      parseCloneCliArgs([
        'acme/proj-private',
        '--upstream=git@github.com:acme/proj.git',
      ])
    ).toEqual({
      vendorRepoUrl: 'acme/proj-private',
      noPublic: false,
      upstreamUrl: 'git@github.com:acme/proj.git',
    });
  });

  test('throws when --upstream has no value', () => {
    expect(() => parseCloneCliArgs(['a/b', '--upstream'])).toThrow(
      '--upstream requires a value'
    );
  });

  test('throws when --upstream= is empty', () => {
    expect(() => parseCloneCliArgs(['a/b', '--upstream='])).toThrow(
      '--upstream requires a value'
    );
  });

  test('flag order does not matter', () => {
    expect(
      parseCloneCliArgs([
        '--no-public',
        '--upstream=git@github.com:acme/proj.git',
        'acme/proj-private',
      ])
    ).toEqual({
      vendorRepoUrl: 'acme/proj-private',
      noPublic: true,
      upstreamUrl: 'git@github.com:acme/proj.git',
    });
  });
});

describe('parseCloneCliArgs strictness', () => {
  test('rejects unknown flags', () => {
    expect(() => parseCloneCliArgs(['--bogus', 'a/b'])).toThrow(
      "Unknown option '--bogus'. Usage: venfork clone"
    );
  });

  test('rejects an extra positional', () => {
    expect(() => parseCloneCliArgs(['a/b', 'c'])).toThrow(
      "Unexpected argument 'c'. Usage: venfork clone"
    );
  });

  test('accepts a flag before the positional and -- as separator', () => {
    expect(parseCloneCliArgs(['--no-public', 'a/b']).vendorRepoUrl).toBe('a/b');
    expect(parseCloneCliArgs(['--', 'a/b']).vendorRepoUrl).toBe('a/b');
  });

  test('missing value at the end of argv throws', () => {
    expect(() => parseCloneCliArgs(['a/b', '--upstream'])).toThrow(
      '--upstream requires a value'
    );
  });
});

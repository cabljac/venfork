import { describe, expect, test } from 'bun:test';
import { checkCloneInputs, parseCloneCliArgs } from '../../src/clone-args.js';

describe('parseCloneCliArgs', () => {
  test('parses bare positional vendor URL', () => {
    expect(parseCloneCliArgs(['git@github.com:acme/proj-private.git'])).toEqual(
      {
        vendorRepoUrl: 'git@github.com:acme/proj-private.git',
        noPublic: false,
        upstreamUrl: undefined,
        prompt: { yes: false, noInput: false },
        json: false,
      }
    );
  });

  test('--no-public sets the flag', () => {
    expect(parseCloneCliArgs(['acme/proj-private', '--no-public'])).toEqual({
      vendorRepoUrl: 'acme/proj-private',
      noPublic: true,
      upstreamUrl: undefined,
      prompt: { yes: false, noInput: false },
      json: false,
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
      prompt: { yes: false, noInput: false },
      json: false,
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
      prompt: { yes: false, noInput: false },
      json: false,
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
      prompt: { yes: false, noInput: false },
      json: false,
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

describe('parseCloneCliArgs prompt flags', () => {
  test('--no-input reaches the parsed prompt context', () => {
    expect(parseCloneCliArgs(['a/b', '--no-input']).prompt).toEqual({
      yes: false,
      noInput: true,
    });
  });

  test('accepts --yes and -y as a no-op', () => {
    expect(parseCloneCliArgs(['a/b', '--yes']).prompt.yes).toBe(true);
    expect(parseCloneCliArgs(['a/b', '-y']).prompt.yes).toBe(true);
  });
});

describe('parseCloneCliArgs --public-fork', () => {
  test('value form', () => {
    expect(
      parseCloneCliArgs(['a/b-private', '--public-fork', 'acme/b'])
        .publicForkUrl
    ).toBe('acme/b');
  });

  test('= form, trimmed', () => {
    expect(
      parseCloneCliArgs([
        'a/b-private',
        '--public-fork= git@github.com:acme/b.git ',
      ]).publicForkUrl
    ).toBe('git@github.com:acme/b.git');
  });

  test('absent leaves it undefined', () => {
    expect(parseCloneCliArgs(['a/b-private']).publicForkUrl).toBeUndefined();
  });

  test('combines with --upstream', () => {
    expect(
      parseCloneCliArgs([
        '--public-fork=acme/b',
        '--upstream',
        'up/b',
        'a/b-private',
      ])
    ).toEqual({
      vendorRepoUrl: 'a/b-private',
      noPublic: false,
      upstreamUrl: 'up/b',
      publicForkUrl: 'acme/b',
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('throws when the value is missing or empty', () => {
    expect(() => parseCloneCliArgs(['a/b', '--public-fork'])).toThrow(
      '--public-fork requires a value'
    );
    expect(() =>
      parseCloneCliArgs(['a/b', '--public-fork', '--no-input'])
    ).toThrow('--public-fork requires a value');
    expect(() => parseCloneCliArgs(['a/b', '--public-fork='])).toThrow(
      '--public-fork requires a value'
    );
  });
});

describe('parseCloneCliArgs --upstream form', () => {
  test('rejects a value that is not a GitHub URL or owner/repo', () => {
    expect(() =>
      parseCloneCliArgs(['a/b-private', '--upstream', 'notaurl'])
    ).toThrow('Invalid --upstream');
  });

  test('checkCloneInputs returns the canonical upstream URL for owner/repo', () => {
    expect(
      checkCloneInputs({ vendorRepoUrl: 'a/b-private', upstreamUrl: 'up/b' })
        .upstreamUrl
    ).toBe('git@github.com:up/b.git');
  });
});

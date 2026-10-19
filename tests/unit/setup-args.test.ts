import { afterEach, describe, expect, test } from 'bun:test';
import { parseSetupCliArgs } from '../../src/setup-args.js';

describe('the renamed --no-public flag', () => {
  test('is a usage error that names --own-upstream', () => {
    expect(() => parseSetupCliArgs(['a/b', '--no-public'])).toThrow(
      '--no-public is now --own-upstream.'
    );
  });
});

describe('parseSetupCliArgs', () => {
  afterEach(() => {
    delete process.env.VENFORK_ORG;
  });

  test('parses positional upstream and private mirror name', () => {
    expect(parseSetupCliArgs(['git@github.com:a/b.git', 'b-private'])).toEqual({
      upstreamUrl: 'git@github.com:a/b.git',
      privateMirrorName: 'b-private',
      organization: undefined,
      publicForkRepoName: undefined,
      noPublic: false,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('parses --org value form', () => {
    expect(
      parseSetupCliArgs(['--org', 'acme', 'client/lib.git', 'lib-vendor'])
    ).toEqual({
      upstreamUrl: 'client/lib.git',
      privateMirrorName: 'lib-vendor',
      organization: 'acme',
      publicForkRepoName: undefined,
      noPublic: false,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('parses --org=equal form', () => {
    expect(parseSetupCliArgs(['u/r', 'r-priv', '--org=corp'])).toEqual({
      upstreamUrl: 'u/r',
      privateMirrorName: 'r-priv',
      organization: 'corp',
      publicForkRepoName: undefined,
      noPublic: false,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('parses --fork-name and --fork-name=', () => {
    expect(
      parseSetupCliArgs([
        'o/p',
        'p-private',
        '--org',
        'o',
        '--fork-name',
        'p-public',
      ])
    ).toEqual({
      upstreamUrl: 'o/p',
      privateMirrorName: 'p-private',
      organization: 'o',
      publicForkRepoName: 'p-public',
      noPublic: false,
      prompt: { yes: false, noInput: false },
      json: false,
    });

    expect(
      parseSetupCliArgs(['o/p.git', 'priv', '--fork-name=other-fork'])
    ).toEqual({
      upstreamUrl: 'o/p.git',
      privateMirrorName: 'priv',
      organization: undefined,
      publicForkRepoName: 'other-fork',
      noPublic: false,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('uses VENFORK_ORG when --org omitted', () => {
    process.env.VENFORK_ORG = 'from-env';
    expect(parseSetupCliArgs(['a/b'])).toEqual({
      upstreamUrl: 'a/b',
      privateMirrorName: undefined,
      organization: 'from-env',
      organizationFromEnv: true,
      publicForkRepoName: undefined,
      noPublic: false,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('--org overrides VENFORK_ORG', () => {
    process.env.VENFORK_ORG = 'env';
    expect(parseSetupCliArgs(['a/b', '--org', 'flag'])).toEqual({
      upstreamUrl: 'a/b',
      privateMirrorName: undefined,
      organization: 'flag',
      publicForkRepoName: undefined,
      noPublic: false,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('throws when --org has no value', () => {
    expect(() =>
      parseSetupCliArgs(['https://github.com/a/b', '--org'])
    ).toThrow('--org requires a value');
  });

  test('throws when --org= is empty', () => {
    expect(() =>
      parseSetupCliArgs(['https://github.com/a/b', '--org='])
    ).toThrow('--org requires a value');
  });

  test('throws when --fork-name has no value', () => {
    expect(() =>
      parseSetupCliArgs(['https://github.com/a/b', '--fork-name'])
    ).toThrow('--fork-name requires a value');
  });

  test('throws when --fork-name= is empty', () => {
    expect(() =>
      parseSetupCliArgs(['https://github.com/a/b', '--fork-name='])
    ).toThrow('--fork-name requires a value');
  });

  test('--own-upstream sets noPublic flag', () => {
    expect(parseSetupCliArgs(['a/b', 'b-private', '--own-upstream'])).toEqual({
      upstreamUrl: 'a/b',
      privateMirrorName: 'b-private',
      organization: undefined,
      publicForkRepoName: undefined,
      noPublic: true,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('--own-upstream + --fork-name throws (incompatible)', () => {
    expect(() =>
      parseSetupCliArgs([
        'a/b',
        'b-private',
        '--own-upstream',
        '--fork-name',
        'foo',
      ])
    ).toThrow(/own-upstream.*cannot be combined.*fork-name/i);
  });

  test('--own-upstream coexists with the positional private mirror name', () => {
    // Positional arg #2 is `privateMirrorName`, not a fork name - only
    // --fork-name (or --fork-name=) sets `publicForkRepoName`. So
    // --own-upstream + a private mirror name must NOT throw.
    expect(
      parseSetupCliArgs(['a/b', 'b-private', '--own-upstream']).noPublic
    ).toBe(true);
  });
});

describe('parseSetupCliArgs strictness', () => {
  test('rejects unknown flags', () => {
    expect(() => parseSetupCliArgs(['--bogus', 'a/b'])).toThrow(
      "Unknown option '--bogus'. Usage: venfork setup"
    );
    expect(() => parseSetupCliArgs(['a/b', '-x'])).toThrow(
      "Unknown option '-x'"
    );
  });

  test('rejects a third positional', () => {
    expect(() => parseSetupCliArgs(['a/b', 'c', 'd'])).toThrow(
      "Unexpected argument 'd'. Usage: venfork setup"
    );
  });

  test('accepts flags before positionals and after --', () => {
    expect(parseSetupCliArgs(['--org=acme', 'a/b']).upstreamUrl).toBe('a/b');
    expect(parseSetupCliArgs(['--', 'a/b']).upstreamUrl).toBe('a/b');
  });

  test('missing value at the end of argv throws', () => {
    expect(() => parseSetupCliArgs(['a/b', '--org'])).toThrow(
      '--org requires a value'
    );
    expect(() => parseSetupCliArgs(['a/b', '--fork-name'])).toThrow(
      '--fork-name requires a value'
    );
  });
});

describe('parseSetupCliArgs prompt flags', () => {
  test('--yes, -y and --no-input reach the parsed prompt context', () => {
    expect(parseSetupCliArgs(['a/b', '--yes']).prompt).toEqual({
      yes: true,
      noInput: false,
    });
    expect(parseSetupCliArgs(['-y', 'a/b', '--no-input']).prompt).toEqual({
      yes: true,
      noInput: true,
    });
  });
});

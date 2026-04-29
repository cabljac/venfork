import { afterEach, describe, expect, test } from 'bun:test';
import { parseSetupCliArgs } from '../src/setup-args.js';

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
    });
  });

  test('parses --org=equal form', () => {
    expect(parseSetupCliArgs(['u/r', 'r-priv', '--org=corp'])).toEqual({
      upstreamUrl: 'u/r',
      privateMirrorName: 'r-priv',
      organization: 'corp',
      publicForkRepoName: undefined,
      noPublic: false,
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
    });

    expect(
      parseSetupCliArgs(['o/p.git', 'priv', '--fork-name=other-fork'])
    ).toEqual({
      upstreamUrl: 'o/p.git',
      privateMirrorName: 'priv',
      organization: undefined,
      publicForkRepoName: 'other-fork',
      noPublic: false,
    });
  });

  test('uses VENFORK_ORG when --org omitted', () => {
    process.env.VENFORK_ORG = 'from-env';
    expect(parseSetupCliArgs(['a/b'])).toEqual({
      upstreamUrl: 'a/b',
      privateMirrorName: undefined,
      organization: 'from-env',
      publicForkRepoName: undefined,
      noPublic: false,
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

  test('--no-public sets noPublic flag', () => {
    expect(parseSetupCliArgs(['a/b', 'b-private', '--no-public'])).toEqual({
      upstreamUrl: 'a/b',
      privateMirrorName: 'b-private',
      organization: undefined,
      publicForkRepoName: undefined,
      noPublic: true,
    });
  });

  test('--no-public + --fork-name throws (incompatible)', () => {
    expect(() =>
      parseSetupCliArgs([
        'a/b',
        'b-private',
        '--no-public',
        '--fork-name',
        'foo',
      ])
    ).toThrow(/no-public.*cannot be combined.*fork-name/i);
  });

  test('--no-public coexists with the positional private mirror name', () => {
    // Positional arg #2 is `privateMirrorName`, not a fork name — only
    // --fork-name (or --fork-name=) sets `publicForkRepoName`. So
    // --no-public + a private mirror name must NOT throw.
    expect(
      parseSetupCliArgs(['a/b', 'b-private', '--no-public']).noPublic
    ).toBe(true);
  });
});

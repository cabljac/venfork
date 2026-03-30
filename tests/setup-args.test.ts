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
    });
  });

  test('parses --org=equal form', () => {
    expect(parseSetupCliArgs(['u/r', 'r-priv', '--org=corp'])).toEqual({
      upstreamUrl: 'u/r',
      privateMirrorName: 'r-priv',
      organization: 'corp',
      publicForkRepoName: undefined,
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
    });

    expect(
      parseSetupCliArgs(['o/p.git', 'priv', '--fork-name=other-fork'])
    ).toEqual({
      upstreamUrl: 'o/p.git',
      privateMirrorName: 'priv',
      organization: undefined,
      publicForkRepoName: 'other-fork',
    });
  });

  test('uses VENFORK_ORG when --org omitted', () => {
    process.env.VENFORK_ORG = 'from-env';
    expect(parseSetupCliArgs(['a/b'])).toEqual({
      upstreamUrl: 'a/b',
      privateMirrorName: undefined,
      organization: 'from-env',
      publicForkRepoName: undefined,
    });
  });

  test('--org overrides VENFORK_ORG', () => {
    process.env.VENFORK_ORG = 'env';
    expect(parseSetupCliArgs(['a/b', '--org', 'flag'])).toEqual({
      upstreamUrl: 'a/b',
      privateMirrorName: undefined,
      organization: 'flag',
      publicForkRepoName: undefined,
    });
  });

  test('throws when --org has no value', () => {
    expect(() =>
      parseSetupCliArgs(['https://github.com/a/b', '--org'])
    ).toThrow('--org requires a value');
  });

  test('throws when --fork-name has no value', () => {
    expect(() =>
      parseSetupCliArgs(['https://github.com/a/b', '--fork-name'])
    ).toThrow('--fork-name requires a value');
  });
});

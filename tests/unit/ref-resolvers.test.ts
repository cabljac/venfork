import { describe, expect, test } from 'bun:test';
import { resolveIssueArg } from '../../src/commands/issue.js';
import { resolvePullRequestArg } from '../../src/commands/pull-request.js';

const cases = [
  ['pull request', resolvePullRequestArg, 'pull'],
  ['issue', resolveIssueArg, 'issues'],
] as const;

for (const [label, resolve, segment] of cases) {
  describe(`${label} reference resolver`, () => {
    test('accepts a plain positive number', () => {
      expect(resolve('12', 'o/r').number).toBe(12);
    });

    test('rejects zero and non-decimal numbers', () => {
      for (const bad of ['0', '00', '1e3', '0x10', '-3', '1.5']) {
        expect(() => resolve(bad, 'o/r')).toThrow('Could not parse');
      }
    });

    test('rejects a URL with trailing junk after the number', () => {
      expect(() =>
        resolve(`https://github.com/o/r/${segment}/12abc`, 'o/r')
      ).toThrow('Could not parse');
    });

    test('rejects a URL with a prefix before github.com', () => {
      expect(() =>
        resolve(`https://evilgithub.com/o/r/${segment}/12`, 'o/r')
      ).toThrow('Could not parse');
    });

    test('accepts a URL with a trailing slash, fragment or sub-page', () => {
      for (const tail of ['', '/', '#top', '?x=1', '/files']) {
        expect(
          resolve(`https://github.com/o/r/${segment}/12${tail}`, 'o/r').number
        ).toBe(12);
      }
    });

    test('compares owner and repo case-insensitively', () => {
      expect(
        resolve(`https://github.com/Owner/Repo/${segment}/7`, 'owner/repo')
          .number
      ).toBe(7);
    });

    test('still refuses a different repo', () => {
      expect(() =>
        resolve(`https://github.com/other/repo/${segment}/7`, 'owner/repo')
      ).toThrow('Refused to use');
    });
  });
}

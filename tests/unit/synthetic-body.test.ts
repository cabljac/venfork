import { describe, expect, test } from 'bun:test';
import { syntheticBody } from '../../src/commands/stage.js';

describe('syntheticBody', () => {
  test.each([
    ['a trailing reference', 'feat: add a (#42)', 'feat: add a'],
    ['an inline reference', 'fix #42: crash on start', 'fix: crash on start'],
    ['a leading reference', '#42 fix crash', 'fix crash'],
    ['several references', 'feat: a (#1) (#2) closes #3', 'feat: a closes'],
    ['a reference in a revert', 'Revert "feat: x (#42)"', 'Revert "feat: x"'],
    ['no reference', 'feat: add a', 'feat: add a'],
  ])('strips %s', (_label, subject, expected) => {
    expect(syntheticBody([subject])).toBe(
      `Commits in this branch:\n\n- ${expected}`
    );
  });

  test.each([
    ['empty parentheses', 'fix: make init() idempotent'],
    ['a URL fragment', 'docs: link https://example.com/page#123'],
    ['a reference inside a word', 'fix: issue#12 regression'],
    ['a cross-repo reference', 'fix: see acme/widget#7 now'],
    ['a hex colour', 'fix: header color #fff'],
    ['a C# mention', 'feat: C# bindings'],
  ])('keeps %s', (_label, subject) => {
    expect(syntheticBody([subject])).toBe(
      `Commits in this branch:\n\n- ${subject}`
    );
  });

  test('strips a numeric colour, which reads the same as a reference', () => {
    expect(syntheticBody(['fix: header color #333 to #fff'])).toBe(
      'Commits in this branch:\n\n- fix: header color to #fff'
    );
  });

  test('says so when nothing is left', () => {
    expect(syntheticBody(['(#1)'])).toBe('No description provided.');
  });
});

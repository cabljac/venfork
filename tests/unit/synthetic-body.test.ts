import { describe, expect, test } from 'bun:test';
import { syntheticBody } from '../../src/commands/stage.js';

describe('syntheticBody', () => {
  test.each([
    ['a trailing reference', 'feat: add a (#42)', 'feat: add a'],
    ['an inline reference', 'fix #42: crash on start', 'fix : crash on start'],
    [
      'a cross-repo reference',
      'fix: see acme/widget#7 now',
      'fix: see acme/widget now',
    ],
    ['several references', 'feat: a (#1) (#2) closes #3', 'feat: a closes'],
    ['no reference', 'feat: add a', 'feat: add a'],
  ])('strips %s', (_label, subject, expected) => {
    expect(syntheticBody([subject])).toBe(
      `Commits in this branch:\n\n- ${expected}`
    );
  });

  test('says so when nothing is left', () => {
    expect(syntheticBody(['(#1)'])).toBe('No description provided.');
  });
});

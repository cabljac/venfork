import { describe, expect, test } from 'bun:test';
import { MirrorReferenceError } from '../../src/errors.js';
import {
  assertNoMirrorReference,
  canonicalText,
  findDeniedText,
} from '../../src/shared/deny-list.js';

const TERMS = [
  'git@github.com:acme/widget-private.git',
  'git@github.com:acme/widget-private',
  'acme/widget-private',
  'venfork',
];

describe('findDeniedText', () => {
  test.each([
    [
      'an https URL',
      'see https://github.com/acme/widget-private/pull/3',
      'acme/widget-private',
    ],
    [
      'an ssh URL',
      'from git@github.com:acme/widget-private.git',
      'git@github.com:acme/widget-private.git',
    ],
    ['mixed case', 'ACME/Widget-Private#3', 'acme/widget-private'],
    ['a zero-width space', 'ven​fork', 'venfork'],
    ['the bot email', 'venfork-bot@users.noreply.github.com', 'venfork'],
  ])('finds %s', (_label, text, term) => {
    expect(findDeniedText(text, TERMS)).toBe(term);
  });

  test('passes the public fork and an issue reference', () => {
    expect(findDeniedText('acme/widget#42 (#42)', TERMS)).toBeNull();
  });
});

describe('assertNoMirrorReference', () => {
  test('names where the term was found', () => {
    expect(() =>
      assertNoMirrorReference(
        'ref acme/widget-private',
        'the upstream PR body',
        TERMS
      )
    ).toThrow(MirrorReferenceError);
    expect(() =>
      assertNoMirrorReference(
        'ref acme/widget-private',
        'the upstream PR body',
        TERMS
      )
    ).toThrow("the upstream PR body contains 'acme/widget-private'");
  });
});

describe('canonicalText', () => {
  test.each([
    ['a combining mark', 'veńfork'],
    ['a variation selector', 'ven️fork'],
    ['a soft hyphen', 'ven­fork'],
    ['a Hangul filler', 'venㅤfork'],
  ])('sees through %s', (_label, text) => {
    expect(canonicalText(text)).toBe('venfork');
  });
});

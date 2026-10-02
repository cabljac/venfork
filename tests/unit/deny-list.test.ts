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

  test('canonicalizes the terms as well as the text', () => {
    expect(
      findDeniedText('clone /srv/josé/mirror.git', ['/srv/josé/mirror.git'])
    ).toBe('/srv/josé/mirror.git');
  });
});

describe('findDeniedText with a bare repo name term', () => {
  const NAME_TERMS = [
    'git@github.com:acme/backend.git',
    'git@github.com:acme/backend',
    'acme/backend',
    'backend',
    'venfork',
  ];

  test.each([
    ['a directory of that name', 'Move the client to src/backend/'],
    ['the plain word', 'Move the backend client'],
    ['a file under a directory of that name', 'see src/backend.ts'],
  ])('passes %s', (_label, text) => {
    expect(findDeniedText(text, NAME_TERMS)).toBeNull();
  });

  test.each([
    ['the mirror owner/name', 'see acme/backend', 'acme/backend'],
    ['another owner with the name', 'see someone/backend', 'backend'],
    ['the name with .git', 'clone other/backend.git now', 'backend'],
    ['an https URL', 'https://github.com/x/backend', 'backend'],
  ])('finds %s', (_label, text, term) => {
    expect(findDeniedText(text, NAME_TERMS)).toBe(term);
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

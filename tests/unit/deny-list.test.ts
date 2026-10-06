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
  ])('passes %s in a file name', (_label, text) => {
    expect(findDeniedText(text, NAME_TERMS, { nameMatch: 'owner' })).toBeNull();
  });

  test.each([
    ['the plain word', 'Move the backend client'],
    ['a directory of that name', 'Move the client to src/backend/'],
    ['the name with an issue number', 'see backend#12'],
    ['the name ending a sentence', 'Ported from backend.'],
    ['the name with a hyphen suffix', 'the backend-api service'],
    ['a file with that stem', 'see src/backend.ts'],
  ])('finds %s in a message, title or body', (_label, text) => {
    expect(findDeniedText(text, NAME_TERMS)).toBe('backend');
  });

  test.each([
    ['a longer word', 'the backends service'],
    ['a prefixed name', 'the my-backend service'],
  ])('passes %s in a message, title or body', (_label, text) => {
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

describe('findDeniedText repo boundaries', () => {
  const NAME_TERMS = [
    'git@github.com:acme/widget-private.git',
    'git@github.com:acme/widget-private',
    'acme/widget-private',
    'widget-private',
    'venfork',
  ];

  test.each([
    ['https://github.com/other/widget-private/', 'widget-private'],
    ['https://github.com/other/widget-private/pull/3', 'widget-private'],
    ['see other/widget-private.', 'widget-private'],
    ['clone other/widget-private.git.', 'widget-private'],
    ['acme/widget-private', 'acme/widget-private'],
    ['acme/widget-private.git', 'acme/widget-private'],
    ['acme/widget-private/pull/1', 'acme/widget-private'],
    ['acme/widget-private#7', 'acme/widget-private'],
    ['acme/widget-private?x', 'acme/widget-private'],
  ])('finds %p', (text, term) => {
    expect(findDeniedText(text, NAME_TERMS)).toBe(term);
  });

  test.each([
    'acme/widget-private-public',
    'acme/widget-private-oss',
    'git@github.com:acme/widget-private-public.git',
    'src/widget-private.ts',
    'other/widget-private-v2',
  ])('the URL and owner/name terms pass %p', (text) => {
    const urlTerms = NAME_TERMS.filter((term) => term !== 'widget-private');
    expect(findDeniedText(text, urlTerms)).toBeNull();
  });

  test.each([
    'fix/widget-private-sync',
    'deploy to widget-private-staging first',
    'see widget-private_notes',
    'other/widget-private-v2',
    'src/widget-private.ts',
  ])('the bare name with a suffix matches in word mode: %p', (text) => {
    expect(findDeniedText(text, NAME_TERMS)).toBe('widget-private');
  });

  test.each(['widget-privateer', 'widget-private2', 'my-widget-private'])(
    'a longer word passes in word mode: %p',
    (text) => {
      expect(findDeniedText(text, NAME_TERMS)).toBeNull();
    }
  );

  test.each([
    'src/widget-private-ui/x.ts',
    'src/widget-private_notes/x.ts',
    'src/widget-private.ts',
  ])('a file name with a suffixed name passes in owner mode: %p', (text) => {
    expect(findDeniedText(text, NAME_TERMS, { nameMatch: 'owner' })).toBeNull();
  });

  test('a directory of that name passes in a file name only', () => {
    expect(
      findDeniedText('src/widget-private/a.ts', NAME_TERMS, {
        nameMatch: 'owner',
      })
    ).toBeNull();
    expect(findDeniedText('src/widget-private/a.ts', NAME_TERMS)).toBe(
      'widget-private'
    );
  });

  test.each([
    [
      'a percent-encoded owner/name',
      'acme%2Fwidget-private',
      'acme/widget-private',
    ],
    [
      'a double-encoded owner/name',
      'acme%252Fwidget-private',
      'acme/widget-private',
    ],
    [
      'a percent-encoded URL',
      'return_to=%2Facme%2Fwidget-private%2Fpull%2F5',
      'acme/widget-private',
    ],
  ])('finds %s', (_label, text, term) => {
    expect(findDeniedText(text, NAME_TERMS)).toBe(term);
  });

  test('tolerates a malformed percent sequence', () => {
    expect(findDeniedText('100%zz %E0%A4%A ok', NAME_TERMS)).toBeNull();
  });

  test('finds a GitHub Pages address from the term', () => {
    expect(
      findDeniedText('https://acme.github.io/widget-private/', [
        'acme.github.io/widget-private',
      ])
    ).toBe('acme.github.io/widget-private');
  });

  describe('with nameMatch host for file content', () => {
    test.each([
      'import x from "acme-ui/widget-private"',
      'see someone/widget-private',
      'packages/widget-private',
      'other/widget-private.git',
    ])('a bare name without a host passes %p', (text) => {
      expect(
        findDeniedText(text, NAME_TERMS, { nameMatch: 'host' })
      ).toBeNull();
    });

    test.each([
      'github.com/other/widget-private',
      'github.com:other/widget-private',
      'git@gitlab.com:other/widget-private.git',
      'ssh://git@example.com/other/widget-private',
      'https://example.com/other/widget-private/pull/3',
      'clone https://github.com/other/widget-private.',
    ])('a bare name after a host is found in %p', (text) => {
      expect(findDeniedText(text, NAME_TERMS, { nameMatch: 'host' })).toBe(
        'widget-private'
      );
    });

    test('the mirror owner/name still matches without a host', () => {
      expect(
        findDeniedText('see acme/widget-private', NAME_TERMS, {
          nameMatch: 'host',
        })
      ).toBe('acme/widget-private');
    });
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

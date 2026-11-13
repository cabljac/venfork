import { describe, expect, test } from 'bun:test';
import { applyPatchAndNormalize } from '../../src/config.js';
import {
  ConfigError,
  DeniedTermError,
  MirrorReferenceError,
} from '../../src/errors.js';
import {
  assertNoDeniedTerm,
  assertNoMirrorReference,
  canonicalText,
  customDenyRules,
  findCustomDenied,
  findDeniedText,
} from '../../src/shared/deny-list.js';
import { parseAddedLines } from '../../src/shared/stage-gate.js';

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

describe('customDenyRules and findCustomDenied', () => {
  test('no denyTerms matches nothing', () => {
    const rules = customDenyRules({});
    expect(rules).toEqual({ terms: [] });
    expect(findCustomDenied('anything at all', rules)).toBeNull();
  });

  test('a term matches anywhere, ignoring case, %XX escapes and invisible characters', () => {
    const rules = customDenyRules({ denyTerms: [' Globex '] });
    for (const text of [
      'globex',
      'see GLOBEX-ci',
      'glo%62ex',
      'glo\u200bbex',
    ]) {
      expect(findCustomDenied(text, rules)).toBe('Globex');
    }
    expect(findCustomDenied('glo bex', rules)).toBeNull();
  });

  test('refuses a list that is not strings or holds an empty term', () => {
    for (const config of [
      { denyTerms: 'globex' },
      { denyTerms: [''] },
      { denyTerms: [42] },
      { denyTerms: ['ok', '  '] },
      { denyTerms: ['Globex\nConfidential'] },
      { denyTerms: ['Globex\rConfidential'] },
    ]) {
      expect(() => customDenyRules(config)).toThrow(ConfigError);
    }
  });

  test('assertNoDeniedTerm throws a mirror-reference DeniedTermError naming the place', () => {
    const rules = customDenyRules({ denyTerms: ['globex'] });
    expect(() =>
      assertNoDeniedTerm('Globex PR', 'the upstream PR title', rules)
    ).toThrow(DeniedTermError);
    try {
      assertNoDeniedTerm('Globex PR', 'the upstream PR title', rules);
    } catch (err) {
      expect(err).toMatchObject({
        code: 'mirror-reference',
        details: {
          where: 'the upstream PR title',
          matched: 'globex',
          list: 'custom',
        },
      });
    }
  });
});

describe('denyTerms at config load', () => {
  test('an invalid deny list is refused whenever the config is read', () => {
    const current = {
      version: '1',
      upstreamUrl: 'git@github.com:acme/widget.git',
      publicForkUrl: 'git@github.com:me/widget.git',
    };
    expect(() => applyPatchAndNormalize(current, { denyTerms: [''] })).toThrow(
      ConfigError
    );
    expect(
      applyPatchAndNormalize(current, { denyTerms: ['globex'] })
    ).toMatchObject({ denyTerms: ['globex'] });
  });
});

describe('parseAddedLines', () => {
  test('header-like added lines are content; headers count only before the first hunk', () => {
    const patch = [
      'diff --git a/a.md b/a.md',
      'index 1111111..2222222 100644',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1,0 +1,4 @@',
      '+++ Globex',
      '+++ b/fake.txt',
      '+-- Globex',
      '+--- dashes',
      '-removed',
      'diff --git a/b.bin b/b.bin',
      'new file mode 100644',
      'Binary files /dev/null and b/b.bin differ',
      'diff --git a/old.txt b/new.txt',
      'similarity index 90%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -2,0 +3 @@',
      '+renamed line',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');

    expect(parseAddedLines(patch)).toEqual([
      { file: 'a.md', line: '++ Globex' },
      { file: 'a.md', line: '++ b/fake.txt' },
      { file: 'a.md', line: '-- Globex' },
      { file: 'a.md', line: '--- dashes' },
      { file: 'new.txt', line: 'renamed line' },
    ]);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { stripInternalBlocks } from '../../src/commands.js';
import { RedactionError } from '../../src/errors.js';
import { translateInternalTitle } from '../../src/shared/redaction.js';

describe('stripInternalBlocks', () => {
  test('removes a single block', () => {
    const input =
      'pub<!-- venfork:internal -->priv<!-- /venfork:internal -->lic';
    expect(stripInternalBlocks(input)).toBe('public');
  });

  test('removes multiple sibling blocks', () => {
    const input =
      'A<!-- venfork:internal -->B<!-- /venfork:internal -->C<!-- venfork:internal -->D<!-- /venfork:internal -->E';
    expect(stripInternalBlocks(input)).toBe('ACE');
  });

  test('removes properly-nested blocks (inner private leaks would be a bug)', () => {
    // The iterative-regex approach Copilot flagged would leave behind
    // "AD<!-- /venfork:internal -->E" here. The depth-tracking pass
    // collapses both pairs and leaves only "AE".
    const input =
      'A<!-- venfork:internal -->B<!-- venfork:internal -->C<!-- /venfork:internal -->D<!-- /venfork:internal -->E';
    expect(stripInternalBlocks(input)).toBe('AE');
  });

  test('tolerates whitespace and missing whitespace inside markers', () => {
    const noSpaces = 'A<!--venfork:internal-->B<!--/venfork:internal-->C';
    const extraSpaces =
      'A<!--   venfork:internal   -->B<!--   /venfork:internal   -->C';
    expect(stripInternalBlocks(noSpaces)).toBe('AC');
    expect(stripInternalBlocks(extraSpaces)).toBe('AC');
  });

  test('handles content with no markers verbatim', () => {
    const input = 'just public text\nwith newlines\n';
    expect(stripInternalBlocks(input)).toBe(input);
  });

  test('refuses a dangling close marker instead of guessing', () => {
    const input = 'pub<!-- /venfork:internal -->lic';
    expect(() => stripInternalBlocks(input)).toThrow(RedactionError);
  });

  test('drops content from an unmatched open marker to end-of-input (fail-safe)', () => {
    // A typo'd close marker shouldn't leak the intended-private content
    // — better to drop too much than to publish secrets.
    const input = 'public<!-- venfork:internal -->oops no close';
    expect(stripInternalBlocks(input)).toBe('public');
  });

  test('preserves multi-line content around blocks', () => {
    const input = [
      'Line 1',
      'Line 2',
      '<!-- venfork:internal -->',
      'redacted line',
      '<!-- /venfork:internal -->',
      'Line 3',
    ].join('\n');
    const result = stripInternalBlocks(input);
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).toContain('Line 3');
    expect(result).not.toContain('redacted line');
    expect(result).not.toContain('venfork:internal');
  });

  test('handles repeated calls without leaking regex state', () => {
    // The internal regexes use the `g` flag; the parser must reset
    // lastIndex so a second call doesn't pick up where the first left off.
    const input = 'A<!-- venfork:internal -->B<!-- /venfork:internal -->C';
    expect(stripInternalBlocks(input)).toBe('AC');
    expect(stripInternalBlocks(input)).toBe('AC');
    expect(stripInternalBlocks(input)).toBe('AC');
  });

  test.each([
    ['upper case', 'A<!-- VENFORK:INTERNAL -->B<!-- /VENFORK:INTERNAL -->C'],
    [
      'spaces around the colon',
      'A<!-- venfork : internal -->B<!-- / venfork : internal -->C',
    ],
    [
      'a note after the keyword',
      'A<!-- venfork:internal (draft note) -->B<!-- /venfork:internal -->C',
    ],
    [
      'a mixed-case close',
      'A<!-- venfork:internal -->B<!-- /VenFork:Internal -->C',
    ],
  ])('matches markers with %s', (_label, input) => {
    expect(stripInternalBlocks(input)).toBe('AC');
  });

  test('refuses a misspelled marker that would otherwise publish its content', () => {
    const input = 'A<!-- venfork:intenral -->secret<!-- /venfork:intenral -->C';
    expect(() => stripInternalBlocks(input)).toThrow(RedactionError);
    expect(() => stripInternalBlocks(input)).toThrow('venfork:intenral');
  });

  test('keeps CRLF content around a block', () => {
    const input =
      'one\r\n<!-- venfork:internal -->\r\nsecret\r\n<!-- /venfork:internal -->\r\ntwo';
    expect(stripInternalBlocks(input)).toBe('one\r\n\r\ntwo');
  });
});

describe('stripInternalBlocks comment scanner', () => {
  test('a marker with an arrow in its note is still a marker', () => {
    const input =
      'pub <!-- venfork:internal owner->bob -->SECRET<!-- /venfork:internal --> tail';
    expect(stripInternalBlocks(input)).toBe('pub  tail');
  });

  test('a comment closed with --!> is a marker', () => {
    const input =
      'pub <!-- venfork:internal --!>SECRET<!-- /venfork:internal --!> tail';
    expect(stripInternalBlocks(input)).toBe('pub  tail');
  });

  test('a marker hidden by a zero-width space is still a marker', () => {
    const input =
      'pub <!-- ven\u200bfork:internal -->SECRET<!-- /ven\u200bfork:internal --> tail';
    expect(stripInternalBlocks(input)).toBe('pub  tail');
  });

  test.each([
    ['plain text', 'Staged from acme/widget-private via venfork'],
    ['a triple-dash comment', 'pub <!--- venfork:internal --->SECRET'],
    ['an escaped comment', 'pub &lt;!-- venfork:internal --&gt;SECRET'],
    ['an unclosed comment', 'pub <!-- venfork:internal SECRET'],
  ])('refuses venfork left in %s', (_label, input) => {
    expect(() => stripInternalBlocks(input)).toThrow(RedactionError);
  });

  test('keeps an issue reference', () => {
    expect(stripInternalBlocks('Fixes #42')).toBe('Fixes #42');
  });
});

describe('translateInternalTitle', () => {
  test('strips internal blocks from a title', () => {
    expect(
      translateInternalTitle(
        'Fix parser <!-- venfork:internal -->for ACME-123<!-- /venfork:internal -->'
      )
    ).toBe('Fix parser');
  });
});

describe('VENFORK_ALLOW_SELF_REFERENCE', () => {
  const saved = process.env.VENFORK_ALLOW_SELF_REFERENCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.VENFORK_ALLOW_SELF_REFERENCE;
    else process.env.VENFORK_ALLOW_SELF_REFERENCE = saved;
  });

  test('lets a plain mention through but not an unmatched marker', () => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';

    expect(stripInternalBlocks('We sync with venfork.')).toBe(
      'We sync with venfork.'
    );
    expect(() => stripInternalBlocks('<!-- /venfork:internal -->')).toThrow(
      RedactionError
    );
  });

  test.each([
    [
      'a malformed comment marker',
      'public\n<!- venfork:internal -> budget 50k <!- /venfork:internal ->\nmore',
    ],
    ['a bracket marker', '[venfork:internal] secret [/venfork:internal]'],
    ['a spaced marker', 'VENFORK : Internal notes'],
  ])('still refuses %s left after stripping', (_label, body) => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';

    expect(() => stripInternalBlocks(body)).toThrow(RedactionError);
  });
});

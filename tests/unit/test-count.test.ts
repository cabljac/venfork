import { describe, expect, test } from 'bun:test';
import { checkTestCount, executedTestCount } from '../../scripts/test-count';

const xml = (tests: number, skipped: number) =>
  `<?xml version="1.0"?>\n<testsuites name="bun test" tests="${tests}" assertions="1" failures="0" skipped="${skipped}">\n  <testsuite name="a" tests="${tests}" skipped="${skipped}"></testsuite>\n</testsuites>`;

describe('executedTestCount', () => {
  test('subtracts skipped tests from the root total', () => {
    expect(executedTestCount(xml(10, 3))).toBe(7);
  });

  test('throws when the report has no root totals', () => {
    expect(() => executedTestCount('<testsuites></testsuites>')).toThrow(
      'no <testsuites tests=...>'
    );
  });
});

describe('checkTestCount', () => {
  test('passes at or above the floor', () => {
    expect(checkTestCount('unit', xml(5, 0), { unit: 5 })).toBeNull();
  });

  test('fails below the floor', () => {
    expect(checkTestCount('unit', xml(5, 1), { unit: 5 })).toContain(
      'unit ran 4 tests, expected at least 5'
    );
  });

  test('fails for a suite without a floor', () => {
    expect(checkTestCount('e2e', xml(5, 0), { unit: 5 })).toContain(
      'no floor for suite "e2e"'
    );
  });
});

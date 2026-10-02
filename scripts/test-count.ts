import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Floors per suite, stored in tests/expected-counts.json. */
export type ExpectedCounts = Record<string, number>;

/**
 * Returns the number of tests a bun junit report says actually ran
 * (root `tests` minus root `skipped`).
 */
export function executedTestCount(xml: string): number {
  const root = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? '';
  const tests = root.match(/\btests="(\d+)"/)?.[1];
  if (tests === undefined) {
    throw new Error('junit report has no <testsuites tests=...> totals');
  }
  const skipped = root.match(/\bskipped="(\d+)"/)?.[1] ?? '0';
  return Number(tests) - Number(skipped);
}

/**
 * Compares a suite's junit report with its floor. Returns an error message,
 * or null when the suite ran at least the expected number of tests.
 */
export function checkTestCount(
  suite: string,
  xml: string,
  expected: ExpectedCounts
): string | null {
  const floor = expected[suite];
  if (floor === undefined) {
    return `no floor for suite "${suite}" in tests/expected-counts.json`;
  }
  const ran = executedTestCount(xml);
  if (ran < floor) {
    return `${suite} ran ${ran} tests, expected at least ${floor} (tests/expected-counts.json)`;
  }
  return null;
}

if (import.meta.main) {
  const [suite, reportPath] = process.argv.slice(2);
  if (!suite || !reportPath) {
    console.error('usage: bun scripts/test-count.ts <suite> <junit.xml>');
    process.exit(2);
  }
  const expected = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, '..', 'tests', 'expected-counts.json'),
      'utf8'
    )
  ) as ExpectedCounts;
  const error = checkTestCount(
    suite,
    readFileSync(reportPath, 'utf8'),
    expected
  );
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`${suite}: test count at or above the floor`);
}

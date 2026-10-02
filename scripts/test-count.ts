import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Exact test counts per suite, stored in tests/expected-counts.json. */
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
 * Compares a suite's junit report with its expected count. Returns an error
 * message, or null when the suite ran exactly the expected number of tests.
 */
export function checkTestCount(
  suite: string,
  xml: string,
  expected: ExpectedCounts
): string | null {
  const want = expected[suite];
  if (want === undefined) {
    return `no count for suite "${suite}" in tests/expected-counts.json`;
  }
  const ran = executedTestCount(xml);
  if (ran !== want) {
    return `${suite} ran ${ran} tests, expected ${want} (update tests/expected-counts.json if the change is intended)`;
  }
  return null;
}

/**
 * Checks a junit report file. A report that is missing, or older than
 * `startedAtMs`, means the suite crashed or never ran.
 */
export function checkReportFile(
  suite: string,
  reportPath: string,
  expected: ExpectedCounts,
  startedAtMs: number
): string | null {
  let mtimeMs: number;
  let xml: string;
  try {
    mtimeMs = statSync(reportPath).mtimeMs;
    xml = readFileSync(reportPath, 'utf8');
  } catch {
    return `${suite} suite did not finish: no report at ${reportPath}`;
  }
  if (mtimeMs < startedAtMs) {
    return `${suite} suite did not finish: ${reportPath} predates this run`;
  }
  return checkTestCount(suite, xml, expected);
}

if (import.meta.main) {
  const [suite, reportPath, ...rest] = process.argv.slice(2);
  if (!suite || !reportPath) {
    console.error(
      'usage: bun scripts/test-count.ts <suite> <junit.xml> [--since <epoch-ms>]'
    );
    process.exit(2);
  }
  const sinceIndex = rest.indexOf('--since');
  const startedAtMs = sinceIndex === -1 ? 0 : Number(rest[sinceIndex + 1]);
  const expected = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, '..', 'tests', 'expected-counts.json'),
      'utf8'
    )
  ) as ExpectedCounts;
  const error = checkReportFile(suite, reportPath, expected, startedAtMs);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`${suite}: test count matches tests/expected-counts.json`);
}

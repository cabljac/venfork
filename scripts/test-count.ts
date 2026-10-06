import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Exact test counts per suite, stored in tests/expected-counts.json. */
export type ExpectedCounts = Record<string, number>;

/**
 * Returns the number of tests a bun junit report says actually ran
 * (root `tests` minus root `skipped`). Throws when the report is truncated:
 * it must end with `</testsuites>` and hold as many `<testcase` elements as
 * the root total.
 */
export function executedTestCount(xml: string): number {
  const root = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? '';
  const tests = root.match(/\btests="(\d+)"/)?.[1];
  if (tests === undefined) {
    throw new Error('junit report has no <testsuites tests=...> totals');
  }
  if (!xml.trimEnd().endsWith('</testsuites>')) {
    throw new Error('report truncated: missing closing </testsuites>');
  }
  const cases = xml.match(/<testcase\b/g)?.length ?? 0;
  if (cases !== Number(tests)) {
    throw new Error(
      `report truncated: ${cases} <testcase> elements, totals say ${tests}`
    );
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
  let ran: number;
  try {
    ran = executedTestCount(xml);
  } catch (err) {
    return `${suite}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (ran !== want) {
    return `${suite} ran ${ran} tests, expected ${want} (update tests/expected-counts.json if the change is intended)`;
  }
  return null;
}

/**
 * Checks a junit report file. A missing report means the suite crashed or
 * never ran; callers delete any stale report before the run.
 */
export function checkReportFile(
  suite: string,
  reportPath: string,
  expected: ExpectedCounts
): string | null {
  let xml: string;
  try {
    xml = readFileSync(reportPath, 'utf8');
  } catch {
    return `${suite} suite did not finish: no report at ${reportPath}`;
  }
  return checkTestCount(suite, xml, expected);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [suite, reportPath] = args;
  if (!suite || !reportPath || args.length !== 2) {
    console.error('usage: bun scripts/test-count.ts <suite> <junit.xml>');
    process.exit(2);
  }
  const expected = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, '..', 'tests', 'expected-counts.json'),
      'utf8'
    )
  ) as ExpectedCounts;
  const error = checkReportFile(suite, reportPath, expected);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`${suite}: test count matches tests/expected-counts.json`);
}

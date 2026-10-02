import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkReportFile,
  checkTestCount,
  executedTestCount,
} from '../../scripts/test-count';

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
  test('passes on an exact match', () => {
    expect(checkTestCount('unit', xml(5, 0), { unit: 5 })).toBeNull();
  });

  test('fails below the expected count', () => {
    expect(checkTestCount('unit', xml(5, 1), { unit: 5 })).toContain(
      'unit ran 4 tests, expected 5'
    );
  });

  test('fails above the expected count so a lowered floor cannot hide deleted tests', () => {
    expect(checkTestCount('unit', xml(6, 0), { unit: 5 })).toContain(
      'unit ran 6 tests, expected 5'
    );
  });

  test('fails for a suite without an expected count', () => {
    expect(checkTestCount('e2e', xml(5, 0), { unit: 5 })).toContain(
      'no count for suite "e2e"'
    );
  });
});

describe('checkReportFile', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'venfork-count-'));
  const report = path.join(dir, 'unit.xml');
  const startedAt = 1_700_000_000_000;

  test('fails with "suite did not finish" when the report is missing', () => {
    expect(
      checkReportFile('unit', path.join(dir, 'missing.xml'), { unit: 5 }, 0)
    ).toContain('unit suite did not finish');
  });

  test('fails with "suite did not finish" when the report predates the run', () => {
    writeFileSync(report, xml(5, 0));
    const old = new Date(startedAt - 60_000);
    utimesSync(report, old, old);
    expect(checkReportFile('unit', report, { unit: 5 }, startedAt)).toContain(
      'unit suite did not finish'
    );
  });

  test('passes for a fresh report with the expected count', () => {
    writeFileSync(report, xml(5, 0));
    const fresh = new Date(startedAt + 1000);
    utimesSync(report, fresh, fresh);
    expect(checkReportFile('unit', report, { unit: 5 }, startedAt)).toBeNull();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

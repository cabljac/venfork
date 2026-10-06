import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkReportFile,
  checkTestCount,
  executedTestCount,
} from '../../scripts/test-count';

const xml = (tests: number, skipped: number) => {
  const cases = Array.from({ length: tests }, (_, i) =>
    i < skipped
      ? `    <testcase name="t${i}"><skipped /></testcase>`
      : `    <testcase name="t${i}" />`
  ).join('\n');
  return `<?xml version="1.0"?>\n<testsuites name="bun test" tests="${tests}" assertions="1" failures="0" skipped="${skipped}">\n  <testsuite name="a" tests="${tests}" skipped="${skipped}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
};

describe('executedTestCount', () => {
  test('subtracts skipped tests from the root total', () => {
    expect(executedTestCount(xml(10, 3))).toBe(7);
  });

  test('throws when the report has no root totals', () => {
    expect(() => executedTestCount('<testsuites></testsuites>\n')).toThrow(
      'no <testsuites tests=...>'
    );
  });
});

describe('truncated reports', () => {
  test('a report cut off after the totals header fails as truncated', () => {
    const header = xml(5, 0).split('\n').slice(0, 2).join('\n');
    expect(() => executedTestCount(header)).toThrow('report truncated');
    expect(checkTestCount('unit', header, { unit: 5 })).toContain(
      'report truncated'
    );
  });

  test('a report cut off mid-suite fails as truncated', () => {
    const cut = xml(5, 0).split('\n').slice(0, 4).join('\n');
    expect(checkTestCount('unit', cut, { unit: 5 })).toContain(
      'report truncated'
    );
  });

  test('a report whose testcase elements disagree with the totals fails as truncated', () => {
    const lying = xml(5, 0).replace('    <testcase name="t4" />\n', '');
    expect(checkTestCount('unit', lying, { unit: 5 })).toContain(
      'report truncated'
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

  test('fails with "suite did not finish" when the report is missing', () => {
    expect(
      checkReportFile('unit', path.join(dir, 'missing.xml'), { unit: 5 })
    ).toContain('unit suite did not finish');
  });

  test('passes for a report with the expected count', () => {
    writeFileSync(report, xml(5, 0));
    expect(checkReportFile('unit', report, { unit: 5 })).toBeNull();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('test-count CLI', () => {
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, 'scripts/test-count.ts', ...args], {
      cwd: path.resolve(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });

  test('rejects the retired --since flag with exit 2', () => {
    const result = run('unit', 'whatever.xml', '--since', 'abc');
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('usage');
  });
});

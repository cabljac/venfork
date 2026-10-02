import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dir, '..', '..');
let sandbox: string;

function runSuite(testBody: string, expected: number) {
  mkdirSync(path.join(sandbox, 'tests', 'unit'), { recursive: true });
  writeFileSync(path.join(sandbox, 'tests', 'unit', 'tiny.test.ts'), testBody);
  writeFileSync(
    path.join(sandbox, 'tests', 'expected-counts.json'),
    JSON.stringify({ unit: expected })
  );
  return Bun.spawnSync([process.execPath, 'scripts/run-suite.ts', 'unit'], {
    cwd: sandbox,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'venfork-run-suite-'));
  cpSync(path.join(repo, 'scripts'), path.join(sandbox, 'scripts'), {
    recursive: true,
  });
  writeFileSync(
    path.join(sandbox, 'package.json'),
    JSON.stringify({ scripts: { 'test:unit': 'bun test ./tests/unit' } })
  );
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('run-suite passes when the tests pass and the count matches', () => {
  const result = runSuite(
    "import { test } from 'bun:test';\ntest('ok', () => {});\n",
    1
  );
  expect(result.exitCode).toBe(0);
});

test('run-suite exits non-zero when the test run is killed by SIGKILL', () => {
  const result = runSuite(
    "import { test } from 'bun:test';\ntest('dies', () => { process.kill(process.pid, 'SIGKILL'); });\n",
    1
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.exitCode).not.toBeNull();
});

test('run-suite exits non-zero when the count gate fails', () => {
  const result = runSuite(
    "import { test } from 'bun:test';\ntest('ok', () => {});\n",
    2
  );
  expect(result.exitCode).not.toBe(0);
});

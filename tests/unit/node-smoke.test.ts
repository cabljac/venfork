import { expect, test } from 'bun:test';
import path from 'node:path';
import {
  EXPECTED_DOCTOR_IDS,
  enginesFloorShortfall,
  nodeRangeFloor,
  nonBuiltinImports,
  runtimeDependencyEngines,
  SKIPPED_DOCTOR_IDS,
  verifyDoctorOutput,
} from '../../scripts/smoke-checks';

test('nodeRangeFloor reads the lowest version a range admits', () => {
  expect(nodeRangeFloor('^18.19.0 || >=20.5.0')).toEqual([18, 19, 0]);
  expect(nodeRangeFloor('>= 20.12.0')).toEqual([20, 12, 0]);
  expect(nodeRangeFloor('>=22')).toEqual([22, 0, 0]);
  expect(nodeRangeFloor('~16.4 || 14.x')).toEqual([14, 0, 0]);
  expect(nodeRangeFloor('*')).toEqual([0, 0, 0]);
  expect(nodeRangeFloor('<20')).toEqual([0, 0, 0]);
  expect(nodeRangeFloor('not a range')).toBeNull();
});

test('enginesFloorShortfall names each dependency that needs a newer node', () => {
  const deps = [
    { name: 'a', range: '>=18' },
    { name: 'b', range: '>= 20.12.0' },
  ];
  expect(enginesFloorShortfall('>=22', deps)).toEqual([]);
  expect(enginesFloorShortfall('^18.19.0 || >=20.5.0', deps)).toEqual([
    'b (>= 20.12.0)',
  ]);
});

test('the engines.node floor covers every runtime dependency floor', async () => {
  const root = path.resolve(import.meta.dir, '..', '..');
  const pkg = (await Bun.file(path.join(root, 'package.json')).json()) as {
    engines: { node: string };
  };
  const deps = await runtimeDependencyEngines(root);
  expect(deps.map((d) => d.name)).toContain('@clack/prompts');
  expect(enginesFloorShortfall(pkg.engines.node, deps)).toEqual([]);
});

const mk = (ids: string[], okAt = -1) =>
  JSON.stringify({
    schemaVersion: 1,
    ok: true,
    result: {
      checks: ids.map((id, i) => ({
        id,
        ok:
          i === okAt
            ? false
            : SKIPPED_DOCTOR_IDS.includes(id)
              ? 'skipped'
              : true,
        detail: 'x',
      })),
      links: null,
    },
  });

test('accepts exit 0 with every expected check passing in order', () => {
  expect(verifyDoctorOutput(0, mk(EXPECTED_DOCTOR_IDS))).toBeNull();
});

test('rejects transport passing on a local-path origin', () => {
  const checks = EXPECTED_DOCTOR_IDS.map((id) => ({ id, ok: true }));
  expect(
    verifyDoctorOutput(
      0,
      JSON.stringify({ schemaVersion: 1, ok: true, result: { checks } })
    )
  ).toContain('transport');
});

test('rejects a non-zero exit code', () => {
  expect(verifyDoctorOutput(1, mk(EXPECTED_DOCTOR_IDS))).toContain(
    'exit code 1'
  );
});

test('rejects a failing check', () => {
  expect(verifyDoctorOutput(0, mk(EXPECTED_DOCTOR_IDS, 3))).toContain(
    EXPECTED_DOCTOR_IDS[3]
  );
});

test('rejects a missing, extra or reordered id', () => {
  const ids = [...EXPECTED_DOCTOR_IDS];
  expect(verifyDoctorOutput(0, mk(ids.slice(1)))).toContain('check ids');
  expect(verifyDoctorOutput(0, mk([...ids, 'extra']))).toContain('check ids');
  expect(
    verifyDoctorOutput(0, mk([ids[1], ids[0], ...ids.slice(2)]))
  ).toContain('check ids');
});

test('rejects non-JSON output', () => {
  expect(verifyDoctorOutput(0, 'boom')).toContain('did not print JSON');
});

test('rejects output that is not a success envelope', () => {
  const checks = EXPECTED_DOCTOR_IDS.map((id) => ({ id, ok: true }));
  expect(verifyDoctorOutput(0, JSON.stringify({ checks }))).toContain(
    'envelope'
  );
  expect(
    verifyDoctorOutput(
      0,
      JSON.stringify({ schemaVersion: 1, ok: false, error: {} })
    )
  ).toContain('envelope');
});

test('accepts a bundle that imports only Node builtins', () => {
  const bundle = [
    '#!/usr/bin/env node',
    'import { createRequire } from "node:module";',
    'import fs from "node:fs";',
    'var __require = createRequire(import.meta.url);',
    'var cp = __require("child_process");',
    'const p = require("path");',
    'const s = `git log --format from ${branch}`;',
  ].join('\n');
  expect(nonBuiltinImports(bundle)).toEqual([]);
});

test('lists each non-builtin import, require and dynamic import once', () => {
  const bundle = [
    'import { $ } from "execa";',
    'import * as p from "@clack/prompts";',
    'var a = __require("left-pad");',
    'var b = require("left-pad");',
    'const c = await import("chalk");',
  ].join('\n');
  expect(nonBuiltinImports(bundle)).toEqual([
    '@clack/prompts',
    'chalk',
    'execa',
    'left-pad',
  ]);
});

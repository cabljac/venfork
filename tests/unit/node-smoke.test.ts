import { expect, test } from 'bun:test';
import path from 'node:path';
import {
  EXPECTED_DOCTOR_IDS,
  enginesFloorShortfall,
  nodeRangeFloor,
  runtimeDependencyEngines,
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
    checks: ids.map((id, i) => ({ id, ok: i !== okAt, detail: 'x' })),
    links: null,
  });

test('accepts exit 0 with every expected check passing in order', () => {
  expect(verifyDoctorOutput(0, mk(EXPECTED_DOCTOR_IDS))).toBeNull();
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

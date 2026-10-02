import { expect, test } from 'bun:test';
import {
  EXPECTED_DOCTOR_IDS,
  verifyDoctorOutput,
} from '../../scripts/smoke-checks';

const mk = (ids: string[], okAt = -1) =>
  JSON.stringify(ids.map((id, i) => ({ id, ok: i !== okAt, detail: 'x' })));

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

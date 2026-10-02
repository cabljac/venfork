import { describe, expect, test } from 'bun:test';
import { parseDoctorCliArgs } from '../../src/doctor-args.js';

describe('parseDoctorCliArgs', () => {
  test('defaults to table output', () => {
    expect(parseDoctorCliArgs([])).toEqual({ check: true, json: false });
  });

  test('parses --json', () => {
    expect(parseDoctorCliArgs(['--json'])).toEqual({ check: true, json: true });
  });

  test('rejects unknown options', () => {
    expect(() => parseDoctorCliArgs(['--fix'])).toThrow(
      "Unknown option '--fix'"
    );
  });
});

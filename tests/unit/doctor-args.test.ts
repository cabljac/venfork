import { describe, expect, test } from 'bun:test';
import {
  parseDoctorCliArgs,
  parseStatusCliArgs,
} from '../../src/doctor-args.js';

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

describe('parseStatusCliArgs', () => {
  test('plain status does not run checks', () => {
    expect(parseStatusCliArgs([])).toEqual({ check: false, json: false });
  });

  test('--check runs the doctor checks', () => {
    expect(parseStatusCliArgs(['--check', '--json'])).toEqual({
      check: true,
      json: true,
    });
  });

  test('--json without --check is rejected', () => {
    expect(() => parseStatusCliArgs(['--json'])).toThrow(
      '--json requires --check'
    );
  });
});

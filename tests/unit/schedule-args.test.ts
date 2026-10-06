import { describe, expect, test } from 'bun:test';
import { parseScheduleCliArgs } from '../../src/schedule-args.js';

describe('parseScheduleCliArgs', () => {
  test('defaults to status', () => {
    expect(parseScheduleCliArgs([])).toEqual({ action: 'status' });
    expect(parseScheduleCliArgs(['status'])).toEqual({ action: 'status' });
  });

  test('parses disable', () => {
    expect(parseScheduleCliArgs(['disable'])).toEqual({ action: 'disable' });
  });

  test('parses set with a cron expression', () => {
    expect(parseScheduleCliArgs(['set', '0 */6 * * *'])).toEqual({
      action: 'set',
      cron: '0 */6 * * *',
    });
  });

  test('set without a cron expression throws', () => {
    expect(() => parseScheduleCliArgs(['set'])).toThrow(
      'Missing cron expression. Usage: venfork schedule'
    );
  });

  test('rejects an unknown action', () => {
    expect(() => parseScheduleCliArgs(['frobnicate'])).toThrow(
      "Unknown schedule action 'frobnicate'. Usage: venfork schedule"
    );
  });

  test('rejects unknown options', () => {
    expect(() => parseScheduleCliArgs(['status', '--bogus'])).toThrow(
      "Unknown option '--bogus'. Usage: venfork schedule"
    );
    expect(() => parseScheduleCliArgs(['--bogus'])).toThrow(
      "Unknown option '--bogus'"
    );
  });

  test('rejects extra positionals', () => {
    expect(() => parseScheduleCliArgs(['status', 'x'])).toThrow(
      "Unexpected argument 'x'"
    );
    expect(() => parseScheduleCliArgs(['disable', 'x'])).toThrow(
      "Unexpected argument 'x'"
    );
    expect(() => parseScheduleCliArgs(['set', '0 * * * *', 'x'])).toThrow(
      "Unexpected argument 'x'"
    );
  });

  test('-- ends options', () => {
    expect(parseScheduleCliArgs(['set', '--', '0 * * * *'])).toEqual({
      action: 'set',
      cron: '0 * * * *',
    });
  });
});

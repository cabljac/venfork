import { describe, expect, test } from 'bun:test';
import { parseScheduleCliArgs } from '../../src/schedule-args.js';

describe('parseScheduleCliArgs', () => {
  test('defaults to status', () => {
    expect(parseScheduleCliArgs([])).toEqual({ action: 'status', json: false });
    expect(parseScheduleCliArgs(['status'])).toEqual({
      action: 'status',
      json: false,
    });
  });

  test('parses disable', () => {
    expect(parseScheduleCliArgs(['disable'])).toEqual({
      action: 'disable',
      json: false,
    });
  });

  test('parses set with a cron expression', () => {
    expect(parseScheduleCliArgs(['set', '0 */6 * * *'])).toEqual({
      action: 'set',
      cron: '0 */6 * * *',
      json: false,
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
      json: false,
    });
  });
});

describe('schedule set auth flags', () => {
  test('--app and --token set the auth mode in any position', () => {
    expect(parseScheduleCliArgs(['set', '0 * * * *', '--app'])).toEqual({
      action: 'set',
      cron: '0 * * * *',
      auth: 'app',
      json: false,
    });
    expect(parseScheduleCliArgs(['set', '--token', '0 * * * *'])).toEqual({
      action: 'set',
      cron: '0 * * * *',
      auth: 'token',
      json: false,
    });
  });

  test('without a flag the auth mode is left out so the stored one is kept', () => {
    expect(parseScheduleCliArgs(['set', '0 * * * *'])).not.toHaveProperty(
      'auth'
    );
  });

  test('a repeated flag is accepted, both flags together are not', () => {
    expect(
      parseScheduleCliArgs(['set', '--app', '0 * * * *', '--app']).auth
    ).toBe('app');
    expect(() =>
      parseScheduleCliArgs(['set', '0 * * * *', '--app', '--token'])
    ).toThrow('--app and --token cannot be used together');
  });

  test.each([
    ['status', '--app'],
    ['disable', '--token'],
  ])('%s rejects %s', (action, flag) => {
    expect(() => parseScheduleCliArgs([action, flag])).toThrow(
      `${flag} applies only to 'schedule set'`
    );
  });

  test('--app after -- is a positional, not the flag', () => {
    expect(() =>
      parseScheduleCliArgs(['set', '0 * * * *', '--', '--app'])
    ).toThrow("Unexpected argument '--app'");
  });
});

import { describe, expect, test } from 'bun:test';
import {
  cronMaxIntervalMinutes,
  isValidCronExpression,
} from '../../src/shared/cron.js';

const FROM = new Date('2026-01-05T00:00:00Z');

describe('cronMaxIntervalMinutes', () => {
  test('hourly', () => {
    expect(cronMaxIntervalMinutes('0 * * * *', FROM)).toBe(60);
  });

  test('every six hours', () => {
    expect(cronMaxIntervalMinutes('0 */6 * * *', FROM)).toBe(360);
  });

  test('uneven list uses the longest gap', () => {
    expect(cronMaxIntervalMinutes('0 1,3 * * *', FROM)).toBe(22 * 60);
  });

  test('weekdays only spans the weekend', () => {
    expect(cronMaxIntervalMinutes('30 9 * * 1-5', FROM)).toBe(3 * 24 * 60);
  });

  test('day-of-week 7 means Sunday', () => {
    expect(cronMaxIntervalMinutes('0 0 * * 7', FROM)).toBe(7 * 24 * 60);
  });

  test('monthly', () => {
    expect(cronMaxIntervalMinutes('0 0 1 * *', FROM)).toBe(31 * 24 * 60);
  });

  test('returns null when it fires at most once in the window', () => {
    expect(cronMaxIntervalMinutes('0 0 29 2 *', FROM)).toBeNull();
  });
});

describe('cronMaxIntervalMinutes on unusual input', () => {
  test('yearly cron finds the one-year gap', () => {
    expect(cronMaxIntervalMinutes('0 0 1 1 *', FROM)).toBe(365 * 24 * 60);
  });

  test('step 0 returns null instead of looping forever', () => {
    expect(cronMaxIntervalMinutes('*/0 * * * *', FROM)).toBeNull();
  });

  test('a macro such as @hourly returns null instead of throwing', () => {
    expect(cronMaxIntervalMinutes('@hourly', FROM)).toBeNull();
  });
});

describe('isValidCronExpression', () => {
  test('accepts five valid fields', () => {
    expect(isValidCronExpression('*/15 0-6,22 1 */2 1-5')).toBe(true);
  });

  test.each([
    ['*/0 * * * *'],
    ['@hourly'],
    ['0 * * *'],
    ['60 * * * *'],
    ['0 0 32 * *'],
    ['0 0 * * 8'],
    ['5-1 * * * *'],
  ])('rejects %s', (cron) => {
    expect(isValidCronExpression(cron)).toBe(false);
  });
});

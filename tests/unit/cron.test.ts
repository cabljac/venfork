import { describe, expect, test } from 'bun:test';
import { cronMaxIntervalMinutes } from '../../src/shared/cron.js';

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

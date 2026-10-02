import { describe, expect, test } from 'bun:test';
import {
  compareSemver,
  pinnedVenforkVersion,
} from '../../src/shared/semver.js';
import { generateSyncWorkflow } from '../../src/workflow.js';

describe('compareSemver', () => {
  test.each([
    ['1.2.3', '1.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.10.0', '1.9.9', 1],
    ['0.11.0', '0.10.5', 1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareSemver(a, b) ?? Number.NaN)).toBe(sign);
  });

  test('returns null for an unparseable version', () => {
    expect(compareSemver('latest', '1.0.0')).toBeNull();
  });
});

describe('pinnedVenforkVersion', () => {
  test('reads the pin from a generated workflow', () => {
    expect(
      pinnedVenforkVersion(
        generateSyncWorkflow('0 * * * *', 'standard', '2.3.4')
      )
    ).toBe('2.3.4');
  });

  test('returns null when nothing is pinned', () => {
    expect(pinnedVenforkVersion('run: npm install -g venfork')).toBeNull();
  });
});

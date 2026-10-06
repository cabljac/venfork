import { describe, expect, test } from 'bun:test';
import {
  compareSemver,
  isUnpinnedWorkflow,
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

describe('isUnpinnedWorkflow', () => {
  test('is true for the legacy unpinned install', () => {
    expect(
      isUnpinnedWorkflow(
        '      - run: npm install -g venfork\n      - run: venfork sync\n'
      )
    ).toBe(true);
  });

  test('is true for a floating tag', () => {
    expect(isUnpinnedWorkflow('run: npm install -g venfork@latest')).toBe(true);
  });

  test.each(['standard', 'no-public'] as const)(
    'is false for a generated %s workflow',
    (mode) => {
      expect(
        isUnpinnedWorkflow(generateSyncWorkflow('0 * * * *', mode, '2.3.4'))
      ).toBe(false);
    }
  );

  test('is false for a workflow that does not install venfork', () => {
    expect(isUnpinnedWorkflow('run: npm install -g left-pad')).toBe(false);
    expect(isUnpinnedWorkflow('')).toBe(false);
  });
});

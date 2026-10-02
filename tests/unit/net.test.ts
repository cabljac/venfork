import { describe, expect, test } from 'bun:test';
import { netFailureReason } from '../../src/shared/net.js';

describe('netFailureReason', () => {
  test('prefers the timeout', () => {
    const saved = process.env.VENFORK_GIT_TIMEOUT;
    delete process.env.VENFORK_GIT_TIMEOUT;
    try {
      expect(
        netFailureReason({ timedOut: true, stderr: 'x', exitCode: 1 })
      ).toBe('timed out after 600s');
    } finally {
      if (saved !== undefined) process.env.VENFORK_GIT_TIMEOUT = saved;
    }
  });

  test('falls back from stderr to the exit code', () => {
    expect(netFailureReason({ stderr: ' denied \n', exitCode: 1 })).toBe(
      'denied'
    );
    expect(netFailureReason({ stderr: '', exitCode: 128 })).toBe('exit 128');
  });
});

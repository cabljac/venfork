import { describe, expect, test } from 'bun:test';
import { GIT_NET_TIMEOUT_MS } from '../../src/shared/constants.js';
import { netFailureReason } from '../../src/shared/net.js';

describe('netFailureReason', () => {
  test('prefers the timeout', () => {
    expect(netFailureReason({ timedOut: true, stderr: 'x', exitCode: 1 })).toBe(
      `timed out after ${GIT_NET_TIMEOUT_MS / 1000}s`
    );
  });

  test('falls back from stderr to the exit code', () => {
    expect(netFailureReason({ stderr: ' denied \n', exitCode: 1 })).toBe(
      'denied'
    );
    expect(netFailureReason({ stderr: '', exitCode: 128 })).toBe('exit 128');
  });
});

import { describe, expect, test } from 'bun:test';
import { closedOutputExitCode } from '../../src/shared/closed-output.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe('closedOutputExitCode', () => {
  test('a reader that closed the pipe (EPIPE) keeps the exit code so far', () => {
    expect(closedOutputExitCode(errno('EPIPE'), undefined)).toBe(0);
    expect(closedOutputExitCode(errno('EPIPE'), 1)).toBe(1);
  });

  test('a terminal that hung up (EIO) ends the run like a cancel', () => {
    expect(closedOutputExitCode(errno('EIO'), undefined)).toBe(130);
    expect(closedOutputExitCode(errno('EIO'), 1)).toBe(130);
  });

  test('any other write error is not handled', () => {
    expect(closedOutputExitCode(errno('ENOSPC'), undefined)).toBeNull();
    expect(closedOutputExitCode(new Error('boom'), undefined)).toBeNull();
  });
});

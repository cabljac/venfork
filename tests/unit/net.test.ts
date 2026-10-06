import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let spawnedEnv: Record<string, string> | undefined;

mock.module('execa', () => ({
  $: (options: { env?: Record<string, string> }) => {
    spawnedEnv = options.env;
    return () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  },
}));

import {
  isTransientPushError,
  netExec,
  netFailureReason,
} from '../../src/shared/net.js';

const DEFAULT_OPTS = '-o BatchMode=yes -o ConnectTimeout=15';

describe('netExec ssh command', () => {
  const savedEnv = { ...process.env };
  let repo: string;

  beforeEach(() => {
    spawnedEnv = undefined;
    delete process.env.GIT_SSH_COMMAND;
    process.env.GIT_CONFIG_GLOBAL = os.devNull;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    repo = mkdtempSync(path.join(os.tmpdir(), 'venfork-net-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(repo, { recursive: true, force: true });
  });

  test('appends batch options to a user GIT_SSH_COMMAND', () => {
    process.env.GIT_SSH_COMMAND = 'ssh -i /k';
    netExec(repo);
    expect(spawnedEnv?.GIT_SSH_COMMAND).toBe(`ssh -i /k ${DEFAULT_OPTS}`);
    expect(spawnedEnv?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('appends batch options to core.sshCommand of the cwd repo', () => {
    execFileSync('git', ['config', 'core.sshCommand', 'ssh -i /cfg'], {
      cwd: repo,
    });
    netExec(repo);
    expect(spawnedEnv?.GIT_SSH_COMMAND).toBe(`ssh -i /cfg ${DEFAULT_OPTS}`);
  });

  test('prefers GIT_SSH_COMMAND over core.sshCommand', () => {
    process.env.GIT_SSH_COMMAND = 'ssh -i /env';
    execFileSync('git', ['config', 'core.sshCommand', 'ssh -i /cfg'], {
      cwd: repo,
    });
    netExec(repo);
    expect(spawnedEnv?.GIT_SSH_COMMAND).toBe(`ssh -i /env ${DEFAULT_OPTS}`);
  });

  test('uses the default when neither is set', () => {
    netExec(repo);
    expect(spawnedEnv?.GIT_SSH_COMMAND).toBe(`ssh ${DEFAULT_OPTS}`);
  });

  test('uses the default when cwd does not exist', () => {
    netExec(path.join(repo, 'missing'));
    expect(spawnedEnv?.GIT_SSH_COMMAND).toBe(`ssh ${DEFAULT_OPTS}`);
  });
});

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

describe('isTransientPushError', () => {
  const withStderr = (stderr: string) => ({ stderr });

  test.each([
    'fatal: RPC failed; HTTP 502 curl 22',
    'error: RPC failed; HTTP 408',
    'error: RPC failed; Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds',
    'fatal: unable to access: Connection was reset',
    'fatal: unable to access: Connection reset by peer',
    'fatal: unable to access: Could not resolve host: github.com',
    'error: RPC failed; HTTP 429 curl 22',
    'remote: Too Many Requests',
  ])('retries %s', (stderr) => {
    expect(isTransientPushError(withStderr(stderr))).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(isTransientPushError(withStderr('OPERATION TOO SLOW'))).toBe(true);
  });

  test.each([
    'remote: HTTP 401 unauthorized',
    'fatal: Authentication failed for https://github.com/x/y',
    'remote: Permission denied to user',
    'remote: Repository not found.',
    'remote: error: GH006: Protected branch update failed',
    'fatal: unrecognized failure',
  ])('does not retry %s', (stderr) => {
    expect(isTransientPushError(withStderr(stderr))).toBe(false);
  });

  test('returns false for null, undefined and non-objects', () => {
    expect(isTransientPushError(undefined)).toBe(false);
    expect(isTransientPushError(null)).toBe(false);
    expect(isTransientPushError('Operation too slow')).toBe(false);
    expect(isTransientPushError(42)).toBe(false);
  });
});

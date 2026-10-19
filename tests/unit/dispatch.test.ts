import { describe, expect, mock, test } from 'bun:test';
import type { SyncResult } from '../../src/commands.js';
import {
  assertInRepository,
  partialFailureExitCode,
  requiresGhAuth,
  requiresRepository,
  setupSyncMirror,
} from '../../src/dispatch.js';
import { NotInRepositoryError } from '../../src/errors.js';

const syncStub = (): Promise<SyncResult> =>
  Promise.resolve({
    kind: 'default-branch',
    status: 'up-to-date',
    branch: 'main',
    upstreamTip: 'a',
    origin: { tip: 'a', pushed: false },
  });

describe('requiresGhAuth', () => {
  test.each([
    ['setup', ['acme/widget'], true],
    ['clone', ['acme/widget-private'], true],
    ['pull', ['pr', '12'], true],
    ['pull', ['issue', '3'], true],
    ['pull', ['--no-push', 'pr', '5'], true],
    ['pull', [], false],
    ['pull', ['pr'], false],
    ['pull', ['issue'], false],
    ['pull', ['pr', '5', '--bogus'], false],
    ['pull', ['nope', '5'], false],
    ['stage', ['issue', '3'], true],
    ['stage', ['branch', 'feature'], true],
    ['stage', ['branch', 'feature', '--no-pr'], false],
    ['stage', ['branch', 'feature', '--pr'], true],
    ['stage', ['issue'], false],
    ['stage', ['feature'], true],
    ['stage', ['feature', '--no-pr'], false],
    ['stage', ['feature', '--no-pr', '--base', 'dev'], false],
    ['stage', ['feature', '--pr'], true],
    ['stage', ['feature', '--draft'], true],
    ['stage', ['feature', '--title', 'x', '--base', 'main'], true],
    ['sync', [], false],
    ['schedule', ['set', '0 * * * *'], false],
    ['workflows', ['status'], false],
    ['preserve', ['list'], false],
    ['doctor', [], false],
    ['help', [], false],
  ] as const)('%s %p -> %p', (command, args, expected) => {
    expect(requiresGhAuth(command, [...args])).toBe(expected);
  });
});

describe('requiresRepository', () => {
  test('the commands that run in a mirror clone, not setup, clone or doctor', () => {
    for (const command of [
      'sync',
      'stage',
      'pull',
      'schedule',
      'workflows',
      'preserve',
    ]) {
      expect(requiresRepository(command)).toBe(true);
    }
    for (const command of ['setup', 'clone', 'doctor']) {
      expect(requiresRepository(command)).toBe(false);
    }
  });
});

describe('assertInRepository', () => {
  const outside = () => Promise.resolve(false);
  const inside = () => Promise.resolve(true);

  test('a mirror command outside a repository is not-in-repository', async () => {
    for (const command of [
      'sync',
      'stage',
      'pull',
      'schedule',
      'workflows',
      'preserve',
    ]) {
      await expect(assertInRepository(command, outside)).rejects.toBeInstanceOf(
        NotInRepositoryError
      );
    }
  });

  test('a mirror command inside a repository passes', async () => {
    await expect(assertInRepository('sync', inside)).resolves.toBeUndefined();
  });

  test('doctor, setup and clone do not check for a repository', async () => {
    const inRepository = mock(outside);
    for (const command of ['doctor', 'setup', 'clone']) {
      await assertInRepository(command, inRepository);
    }
    expect(inRepository).not.toHaveBeenCalled();
  });
});

describe('setupSyncMirror', () => {
  test('runs a quiet sync of the given clone', async () => {
    const sync = mock(syncStub);
    await setupSyncMirror(sync)('/work/acme-private');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith({
      cwd: '/work/acme-private',
      quiet: true,
    });
  });
});

describe('partialFailureExitCode', () => {
  const staged = {
    branch: 'feat',
    head: 'h',
    target: 'public' as const,
    compareUrl: 'u',
  };

  test('stage exits 1 when the push worked and the PR could not be opened', () => {
    expect(
      partialFailureExitCode({
        command: 'stage',
        result: { ...staged, prAction: 'failed' },
      })
    ).toBe(1);
    expect(
      partialFailureExitCode({
        command: 'stage',
        result: { ...staged, prAction: 'created' },
      })
    ).toBe(0);
    expect(partialFailureExitCode({ command: 'stage', result: staged })).toBe(
      0
    );
  });

  test('pull pr exits 1 when the asked-for push to origin failed', () => {
    const pulled = {
      branch: 'b',
      head: 'h',
      prNumber: 1,
      prUrl: 'u',
      refreshed: false,
    };
    expect(
      partialFailureExitCode({
        command: 'pull pr',
        result: { ...pulled, pushed: false },
        push: true,
      })
    ).toBe(1);
    expect(
      partialFailureExitCode({
        command: 'pull pr',
        result: { ...pulled, pushed: false },
        push: false,
      })
    ).toBe(0);
  });
});

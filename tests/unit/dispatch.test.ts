import { describe, expect, mock, test } from 'bun:test';
import type { SyncResult } from '../../src/commands.js';
import {
  outsideRepositoryError,
  requiresGhAuth,
  requiresRepository,
  setupSyncMirror,
} from '../../src/dispatch.js';
import {
  CommandExitError,
  GitError,
  MissingInputError,
  NotInRepositoryError,
  UsageError,
} from '../../src/errors.js';

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
    ['stage', ['branch', 'feature'], false],
    ['stage', ['branch', 'feature', '--pr'], true],
    ['stage', ['issue'], false],
    ['stage', ['feature'], false],
    ['stage', ['feature', '--pr'], true],
    ['stage', ['feature', '--draft'], true],
    ['stage', ['feature', '--title', 'x', '--base', 'main'], false],
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

describe('outsideRepositoryError', () => {
  const outside = () => Promise.resolve(false);
  const inside = () => Promise.resolve(true);

  test('a runtime failure of a mirror command outside a repository is not-in-repository', async () => {
    const reported = await outsideRepositoryError(
      'sync',
      new GitError('fetch failed', 'fetch'),
      outside
    );
    expect(reported).toBeInstanceOf(NotInRepositoryError);
  });

  test('a reported failure (exit 1) outside a repository is not-in-repository', async () => {
    const reported = await outsideRepositoryError(
      'stage',
      new CommandExitError(1, new GitError('no remote', 'remote')),
      outside
    );
    expect(reported).toBeInstanceOf(NotInRepositoryError);
  });

  test('a failure inside a repository keeps its own error', async () => {
    const error = new GitError('fetch failed', 'fetch');
    expect(await outsideRepositoryError('sync', error, inside)).toBe(error);
  });

  test.each([
    ['a usage error', new UsageError('Usage: venfork stage <branch>')],
    ['a missing input', new MissingInputError('--yes', 'Push to public fork?')],
    [
      'a reported missing input',
      new CommandExitError(1, new MissingInputError('--yes', 'Open it?')),
    ],
    ['a cancel', new CommandExitError(130)],
  ])(
    '%s outside a repository keeps its own error and exit code',
    async (_name, error) => {
      expect(await outsideRepositoryError('stage', error, outside)).toBe(error);
    }
  );

  test('doctor, setup and clone keep their own error outside a repository', async () => {
    const error = new GitError('fetch failed', 'fetch');
    for (const command of ['doctor', 'setup', 'clone']) {
      expect(await outsideRepositoryError(command, error, outside)).toBe(error);
    }
  });
});

describe('setupSyncMirror', () => {
  test('runs a quiet sync of the given clone', async () => {
    const sync = mock(syncStub);
    await setupSyncMirror(sync)('/work/acme-private');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(undefined, {
      cwd: '/work/acme-private',
      quiet: true,
    });
  });
});

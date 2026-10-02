import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { syncCommand } from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
import { SyncDivergenceError } from '../../src/errors.js';
import { getDefaultBranch } from '../../src/git.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

let fx: MirrorFixture;
const originalCwd = process.cwd();
const originalExit = process.exit;

beforeEach(async () => {
  fx = await createMirrorFixture();
  process.exit = mock((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(async () => {
  process.exit = originalExit;
  process.chdir(originalCwd);
  await fx.cleanup();
});

function sync(): Promise<void> {
  return syncCommand(undefined, { cwd: fx.work, quiet: true });
}

function enableSchedule(): Promise<unknown> {
  return updateVenforkConfig(fx.work, {
    schedule: { enabled: true, cron: '0 * * * *' },
  });
}

function setClock(epochSeconds: number): void {
  const date = `@${epochSeconds} +0000`;
  process.env.GIT_AUTHOR_DATE = date;
  process.env.GIT_COMMITTER_DATE = date;
}

describe('harness', () => {
  test('getDefaultBranch resolves a local path remote', async () => {
    const trunk = await createMirrorFixture({ defaultBranch: 'trunk' });
    try {
      expect(await getDefaultBranch('upstream', trunk.work)).toBe('trunk');
    } finally {
      await trunk.cleanup();
    }
  });

  test('plain sync fast-forwards origin and public to upstream', async () => {
    const upstreamTip = await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });

    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(upstreamTip);
    expect(await fx.sha(fx.publicFork ?? '', 'main')).toBe(upstreamTip);
  });
});

describe('sync with the managed commit', () => {
  // Red until sync builds the managed commit deterministically.
  test.todo(
    'sync twice with no upstream change yields the same origin SHA',
    async () => {
      await enableSchedule();

      setClock(1_800_000_000);
      await sync();
      const first = await fx.sha(fx.origin, 'main');

      setClock(1_800_003_600);
      await sync();
      const second = await fx.sha(fx.origin, 'main');

      expect(second).toBe(first);
    }
  );

  // Red until sync stops pushing bare upstream before the managed commit.
  test.todo('sync pushes origin exactly once', async () => {
    await enableSchedule();
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const before = await fx.pushCount(fx.origin, 'refs/heads/main');

    await sync();

    expect((await fx.pushCount(fx.origin, 'refs/heads/main')) - before).toBe(1);
  });

  test('sync throws SyncDivergenceError on a user commit to origin/main', async () => {
    await fx.commitOnOrigin({ 'src/hotfix.ts': 'export {};\n' });
    const originBefore = await fx.sha(fx.origin, 'main');

    const error = await sync().then(
      () => null,
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(SyncDivergenceError);
    const divergence = error as SyncDivergenceError;
    expect(divergence.origin).toEqual({ count: 1, files: ['src/hotfix.ts'] });
    expect(divergence.publicFork).toEqual({ count: 0, files: [] });
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });
});

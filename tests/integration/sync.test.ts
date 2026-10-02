import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { preserveCommand, syncCommand } from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
import { SyncDivergenceError } from '../../src/errors.js';
import { getDefaultBranch } from '../../src/git.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

const MANAGED_SUBJECT = 'chore: venfork-managed mirror commit';
const CALLER = '.github/workflows/caller.yml';

let fx: MirrorFixture;
let active: MirrorFixture | undefined;
const originalCwd = process.cwd();
const originalExit = process.exit;

beforeEach(async () => {
  fx = await createMirrorFixture();
  active = fx;
  process.exit = mock((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(async () => {
  process.exit = originalExit;
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
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

  test('preserve carries a file across sync; upstream version wins when it appears upstream', async () => {
    process.chdir(fx.work);
    await preserveCommand('add', [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror version\n' });

    await fx.commitOnUpstream({ 'src/a.txt': 'a\n' });
    await sync();

    const upstreamTip = await fx.sha(fx.upstream, 'main');
    expect(await fx.subjects(fx.origin, 'main', 'main~1..main')).toEqual([
      MANAGED_SUBJECT,
    ]);
    expect(await fx.sha(fx.origin, 'main~1')).toBe(upstreamTip);
    expect(await fx.fileAt(fx.origin, 'main', CALLER)).toBe('mirror version\n');

    await fx.commitOnUpstream({ [CALLER]: 'upstream version\n' });
    await sync();

    expect(await fx.fileAt(fx.origin, 'main', CALLER)).toBe(
      'upstream version\n'
    );
  });

  test('preserve keeps the executable bit of a preserved script', async () => {
    process.chdir(fx.work);
    await preserveCommand('add', ['scripts/release.sh']);
    await fx.commitOnOrigin({
      'scripts/release.sh': { content: '#!/bin/sh\n', executable: true },
    });

    await sync();

    expect(await fx.modeAt(fx.origin, 'main', 'scripts/release.sh')).toBe(
      '100755'
    );
  });

  test('a glob preserve entry is dropped and never reverts an upstream change', async () => {
    await updateVenforkConfig(fx.work, { preserve: ['src/file-*.txt'] });
    await sync();
    await fx.commitOnUpstream({ 'src/file-1.txt': 'upstream new\n' });

    await sync();

    expect(await fx.fileAt(fx.origin, 'main', 'src/file-1.txt')).toBe(
      'upstream new\n'
    );
  });

  test('a pathspec-magic preserve entry is dropped and never rolls the tree back', async () => {
    await updateVenforkConfig(fx.work, { preserve: [':!nothing'] });
    await sync();
    const upstreamTip = await fx.commitOnUpstream({ 'src/added.txt': 'x\n' });

    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(upstreamTip);
  });

  test('a preserved file whose parent becomes an upstream file fails and names both paths', async () => {
    process.chdir(fx.work);
    await preserveCommand('add', ['config/x.yml']);
    await fx.commitOnOrigin({ 'config/x.yml': 'mirror\n' });
    await sync();
    await fx.commitOnUpstream({ config: 'upstream file named config\n' });

    await expect(sync()).rejects.toThrow('process.exit(1)');

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Preserved file 'config/x.yml' cannot be restored: upstream now has a file at 'config'"
      )
    );
  });

  test('a preserve entry that is a directory on the mirror is rejected', async () => {
    process.chdir(fx.work);
    await preserveCommand('add', ['tools/a.sh', 'tools/b.sh']);
    await fx.commitOnOrigin({ 'tools/a.sh': 'a\n', 'tools/b.sh': 'b\n' });
    await sync();
    await updateVenforkConfig(fx.work, { preserve: ['tools'] });
    await fx.commitOnUpstream({ 'src/z.txt': 'z\n' });

    await expect(sync()).rejects.toThrow('process.exit(1)');

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Preserved path 'tools' is a directory on origin/main; preserve supports single files only"
      )
    );
  });
});

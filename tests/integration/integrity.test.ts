import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import {
  preserveCommand,
  runDoctorChecks,
  scheduleCommand,
  stageCommand,
  syncCommand,
} from '../../src/commands.js';
import {
  createConfigBranch,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
} from '../../src/config.js';
import { SyncDivergenceError } from '../../src/errors.js';
import { buildMirrorTip } from '../../src/shared/mirror-commit.js';
import { netExec, netFailureReason } from '../../src/shared/net.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

const WF = '.github/workflows/venfork-sync.yml';

let fx: MirrorFixture;
let active: MirrorFixture | undefined;
const originalCwd = process.cwd();

beforeEach(async () => {
  fx = await createMirrorFixture();
  active = fx;
  process.chdir(fx.work);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
});

const sync = () => syncCommand(undefined, { cwd: fx.work, quiet: true });

/** Checks out origin's default branch in the fixture's second clone. */
async function originDev(): Promise<string> {
  const dev = path.join(fx.root, 'origin-dev');
  await fx.git(dev, 'fetch', '--quiet', 'origin');
  await fx.git(dev, 'checkout', '--quiet', 'main');
  await fx.git(dev, 'reset', '--quiet', '--hard', 'origin/main');
  return dev;
}

async function expectSyncError(message: string): Promise<void> {
  await expect(sync()).rejects.toThrow('process.exit(1)');
  expect(prompts.log.error).toHaveBeenCalledWith(
    expect.stringContaining(message)
  );
}

describe('preserve cannot capture venfork state', () => {
  test('preserving the sync workflow is refused, so schedule set still rewrites it', async () => {
    await scheduleCommand('set', '0 * * * *');

    await expect(preserveCommand('add', [WF])).rejects.toThrow(
      'process.exit(1)'
    );
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid preserve path '${WF}'`)
    );
    await scheduleCommand('set', '30 2 * * *');

    expect(await fx.fileAt(fx.origin, 'main', WF)).toContain(
      "cron: '30 2 * * *'"
    );
  });
});

describe('managed commit content check', () => {
  test('user work amended into the managed commit is divergence, not dropped', async () => {
    await scheduleCommand('set', '0 * * * *');
    const dev = await originDev();
    await writeFile(path.join(dev, 'src/user-work.txt'), 'important\n');
    await fx.git(dev, 'add', 'src/user-work.txt');
    await fx.git(dev, 'commit', '--quiet', '--amend', '--no-edit');
    await fx.git(dev, 'push', '--quiet', '--force', 'origin', 'main');
    await fx.commitOnUpstream({ 'src/up.txt': 'u\n' });

    await expect(sync()).rejects.toBeInstanceOf(SyncDivergenceError);

    expect(await fx.fileAt(fx.origin, 'main', 'src/user-work.txt')).toBe(
      'important\n'
    );
  });

  test('a commit with the managed subject and user work is divergence, not dropped', async () => {
    await fx.commitOnOrigin(
      { [WF]: 'name: old\n', 'src/user-work.txt': 'important\n' },
      'chore: venfork-managed mirror commit'
    );
    await fx.commitOnUpstream({ 'src/up.txt': 'u\n' });

    await expect(sync()).rejects.toBeInstanceOf(SyncDivergenceError);

    expect(await fx.fileAt(fx.origin, 'main', 'src/user-work.txt')).toBe(
      'important\n'
    );
  });

  test('a commit with a legacy managed subject and user work is divergence, not dropped', async () => {
    await fx.commitOnOrigin(
      { 'src/user-work.txt': 'important\n' },
      'chore: add/update scheduled sync workflow (venfork)'
    );

    await expect(sync()).rejects.toBeInstanceOf(SyncDivergenceError);

    expect(await fx.fileAt(fx.origin, 'main', 'src/user-work.txt')).toBe(
      'important\n'
    );
  });

  test('removing a preserve entry re-stamps origin, so the next sync is not divergence', async () => {
    await preserveCommand('add', ['tools/m.txt', 'tools/n.txt']);
    await fx.commitOnOrigin({ 'tools/m.txt': 'm\n', 'tools/n.txt': 'n\n' });
    await sync();

    await preserveCommand('remove', ['tools/n.txt']);
    await fx.commitOnUpstream({ 'src/up.txt': 'u\n' });
    await sync();

    expect(await fx.fileAt(fx.origin, 'main', 'tools/m.txt')).toBe('m\n');
    expect(await fx.fileAt(fx.origin, 'main', 'tools/n.txt')).toBeNull();
  });

  test('a legacy bot commit that only touches the sync workflow is replaced', async () => {
    const dev = await originDev();
    await mkdir(path.join(dev, '.github/workflows'), { recursive: true });
    await writeFile(path.join(dev, WF), 'name: old venfork sync\n');
    await fx.git(dev, 'add', WF);
    await $({
      cwd: dev,
    })`git -c user.name=venfork-bot -c user.email=venfork-bot@users.noreply.github.com commit --quiet -m ${'chore(venfork): hourly sync'}`;
    await fx.git(dev, 'push', '--quiet', 'origin', 'main');

    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(
      await fx.sha(fx.upstream, 'main')
    );
  });
});

describe('managed commit left behind by a preserve removal', () => {
  /** Origin's managed commit carries m and n; the config names only m. */
  async function staleManagedCommit(): Promise<void> {
    await preserveCommand('add', ['tools/m.txt', 'tools/n.txt']);
    await fx.commitOnOrigin({ 'tools/m.txt': 'm\n', 'tools/n.txt': 'n\n' });
    await sync();
    await updateVenforkConfig(fx.work, { preserve: ['tools/m.txt'] });
  }

  test('sync re-stamps the managed commit without the dropped file', async () => {
    await staleManagedCommit();

    await sync();

    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('(stale-trailer)')
    );
    expect(await fx.fileAt(fx.origin, 'main', 'tools/m.txt')).toBe('m\n');
    expect(await fx.fileAt(fx.origin, 'main', 'tools/n.txt')).toBeNull();
    expect(
      await fx.git(
        fx.origin,
        'rev-list',
        '--count',
        `${await fx.sha(fx.upstream, 'main')}..main`
      )
    ).toBe('1');
  });

  test('preserve remove of the dropped file re-stamps origin', async () => {
    await staleManagedCommit();

    await preserveCommand('remove', ['tools/n.txt']);

    expect(await fx.fileAt(fx.origin, 'main', 'tools/n.txt')).toBeNull();
    expect(await fx.fileAt(fx.origin, 'main', 'tools/m.txt')).toBe('m\n');
  });

  test('stage does not publish the dropped file', async () => {
    await staleManagedCommit();
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(
      fx.work,
      'checkout',
      '--quiet',
      '-b',
      'feature',
      'origin/main'
    );
    await writeFile(path.join(fx.work, 'src/a.txt'), 'a\n');
    await fx.git(fx.work, 'add', 'src/a.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: a');

    await stageCommand('feature');

    expect(await fx.fileAt(fx.publicFork ?? '', 'feature', 'src/a.txt')).toBe(
      'a\n'
    );
    expect(
      await fx.fileAt(fx.publicFork ?? '', 'feature', 'tools/n.txt')
    ).toBeNull();
  });

  test('a managed commit amended by a user is still divergence', async () => {
    await staleManagedCommit();
    const dev = await originDev();
    await writeFile(path.join(dev, 'tools/n.txt'), 'n edited\n');
    await fx.git(dev, 'commit', '--quiet', '-a', '--amend', '--no-edit');
    await fx.git(dev, 'push', '--quiet', '--force', 'origin', 'main');

    await expect(sync()).rejects.toBeInstanceOf(SyncDivergenceError);

    expect(await fx.fileAt(fx.origin, 'main', 'tools/n.txt')).toBe(
      'n edited\n'
    );
  });

  test('preserve remove on a diverged origin warns that origin still carries the file', async () => {
    await preserveCommand('add', ['tools/m.txt', 'tools/n.txt']);
    await fx.commitOnOrigin({ 'tools/m.txt': 'm\n', 'tools/n.txt': 'n\n' });
    await sync();
    await fx.commitOnOrigin({ 'src/user.txt': 'user\n' });
    const before = await fx.sha(fx.origin, 'main');

    await preserveCommand('remove', ['tools/n.txt']);

    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "origin/main has diverged and its managed commit still carries 'tools/n.txt'"
      )
    );
    expect(await fx.sha(fx.origin, 'main')).toBe(before);
    expect((await readVenforkConfigFromRepo(fx.work))?.preserve).toEqual([
      'tools/m.txt',
    ]);
  });
});

describe('missing venfork-config branch', () => {
  test('sync refuses when origin still carries a managed commit', async () => {
    await preserveCommand('add', ['tools/m.txt']);
    await fx.commitOnOrigin({ 'tools/m.txt': 'mirror\n' });
    await sync();
    await fx.git(fx.origin, 'branch', '-D', 'venfork-config');

    await expectSyncError('venfork-config branch is missing');

    expect(await fx.fileAt(fx.origin, 'main', 'tools/m.txt')).toBe('mirror\n');
  });

  test('createConfigBranch refuses to overwrite an existing branch', async () => {
    const before = await fx.sha(fx.origin, 'venfork-config');

    await expect(
      createConfigBranch(fx.work, fx.publicFork, fx.upstream)
    ).rejects.toThrow('already exists');

    expect(await fx.sha(fx.origin, 'venfork-config')).toBe(before);
  });
});

describe('schedule changes do not drift from origin', () => {
  test('a newer pinned workflow fails before the config is written', async () => {
    await scheduleCommand('set', '0 * * * *');
    const dev = await originDev();
    const file = path.join(dev, WF);
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        /venfork@[0-9][^"}\s]*/,
        'venfork@99.0.0'
      )
    );
    await fx.git(dev, 'commit', '--quiet', '-a', '--amend', '--no-edit');
    await fx.git(dev, 'push', '--quiet', '--force', 'origin', 'main');

    await expect(scheduleCommand('set', '15 3 * * *')).rejects.toThrow(
      'process.exit(1)'
    );

    expect((await readVenforkConfigFromRepo(fx.work))?.schedule?.cron).toBe(
      '0 * * * *'
    );
  });

  test('a rejected origin push rolls the config back', async () => {
    const hook = path.join(fx.origin, 'hooks', 'pre-receive');
    await writeFile(
      hook,
      '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && exit 1; done\nexit 0\n'
    );
    await chmod(hook, 0o755);

    await expect(scheduleCommand('set', '0 * * * *')).rejects.toThrow(
      'process.exit(1)'
    );

    expect(
      (await readVenforkConfigFromRepo(fx.work))?.schedule
    ).toBeUndefined();
  });
});

describe('tip builder path conflicts', () => {
  test('a preserved file replaced by an upstream directory fails and names both', async () => {
    await preserveCommand('add', ['cfg']);
    await fx.commitOnOrigin({ cfg: 'mirror cfg\n' });
    await sync();
    const before = await fx.sha(fx.origin, 'main');
    await fx.commitOnUpstream({ 'cfg/inner.txt': 'upstream dir\n' });

    await expectSyncError(
      "Preserved file 'cfg' cannot be restored: upstream now has a directory at 'cfg'"
    );

    expect(await fx.sha(fx.origin, 'main')).toBe(before);
  });

  test('a preserved path below the sync workflow file fails with a clear error', async () => {
    await scheduleCommand('set', '0 * * * *');
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    const upstreamTip = await fx.git(fx.work, 'rev-parse', 'upstream/main');
    const mirrorTip = await fx.git(fx.work, 'rev-parse', 'origin/main');

    await expect(
      buildMirrorTip({
        defaultBranch: 'main',
        upstreamTip,
        schedule: { cron: '0 * * * *', mode: 'standard' },
        enabledWorkflows: [],
        disabledWorkflows: [],
        preserve: [`${WF}/x`],
        previousMirrorTip: mirrorTip,
        cwd: fx.work,
      })
    ).rejects.toThrow(`a file exists at '${WF}'`);
  });

  test('a gitlink at a preserved path is rejected', async () => {
    const dev = await originDev();
    const head = await fx.git(dev, 'rev-parse', 'HEAD');
    await fx.git(
      dev,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${head},msub`
    );
    await fx.git(dev, 'commit', '--quiet', '-m', 'chore: mirror gitlink');
    await fx.git(dev, 'push', '--quiet', 'origin', 'main');
    await preserveCommand('add', ['msub']);

    await expectSyncError(
      "Preserved path 'msub' is not a regular file, executable or symlink"
    );
  });
});

describe('workflow allowlist', () => {
  test('only top-level workflow files are filtered', async () => {
    await fx.commitOnUpstream({
      '.github/workflows/ci.yml': 'ci\n',
      '.github/workflows/lint.yaml': 'lint\n',
      '.github/workflows/scripts/helper.sh': 'echo\n',
      '.github/workflows/sub/nested.yml': 'nested\n',
    });
    await updateVenforkConfig(fx.work, {
      schedule: { enabled: true, cron: '0 * * * *' },
      enabledWorkflows: ['ci.yml'],
    });

    await sync();

    const names = await fx.git(
      fx.origin,
      'ls-tree',
      '-r',
      '--name-only',
      'main',
      '--',
      '.github'
    );
    expect(names.split('\n').sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/scripts/helper.sh',
      '.github/workflows/sub/nested.yml',
      WF,
    ]);
  });
});

describe('sync leaves the user clone alone', () => {
  test('a dirty index and worktree are byte-identical after sync', async () => {
    await preserveCommand('add', ['tools/m.txt']);
    await fx.commitOnOrigin({ 'tools/m.txt': 'mirror\n' });
    await updateVenforkConfig(fx.work, {
      schedule: { enabled: true, cron: '0 * * * *' },
    });
    await fx.commitOnUpstream({ 'src/u.txt': 'u\n' });
    await writeFile(path.join(fx.work, 'src/file-1.txt'), 'dirty worktree\n');
    await writeFile(path.join(fx.work, 'staged.txt'), 'staged\n');
    await fx.git(fx.work, 'add', 'staged.txt');
    const indexBefore = await readFile(path.join(fx.work, '.git/index'));
    const statusBefore = await fx.git(fx.work, 'status', '--porcelain');

    await sync();

    expect(await fx.git(fx.work, 'status', '--porcelain')).toBe(statusBefore);
    expect(
      Buffer.compare(
        indexBefore,
        await readFile(path.join(fx.work, '.git/index'))
      )
    ).toBe(0);
    expect(await fx.fileAt(fx.origin, 'main', 'tools/m.txt')).toBe('mirror\n');
  });
});

describe('paths with spaces', () => {
  test('doctor reads remotes when the mirror lives under a path with a space', async () => {
    process.chdir(originalCwd);
    await active?.cleanup();
    const spaced = path.join(os.tmpdir(), `venfork space ${process.pid}`);
    await mkdir(spaced, { recursive: true });
    try {
      fx = await createMirrorFixture({ tmpRoot: spaced });
      active = fx;
      process.chdir(fx.work);

      const checks = await runDoctorChecks({ cwd: fx.work });

      expect(checks.find((check) => check.id === 'remotes')?.ok).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await active?.cleanup();
      active = undefined;
      await rm(spaced, { recursive: true, force: true });
    }
  });
});

describe('network timeout', () => {
  test('reads VENFORK_GIT_TIMEOUT when the command runs, not at import', async () => {
    const saved = process.env.VENFORK_GIT_TIMEOUT;
    process.env.VENFORK_GIT_TIMEOUT = '50';
    try {
      const result = await netExec(undefined, { bufferOutput: true })`sleep 5`;

      expect(result.timedOut).toBe(true);
      expect(netFailureReason(result)).toBe('timed out after 0.05s');
    } finally {
      if (saved === undefined) delete process.env.VENFORK_GIT_TIMEOUT;
      else process.env.VENFORK_GIT_TIMEOUT = saved;
    }
  });
});

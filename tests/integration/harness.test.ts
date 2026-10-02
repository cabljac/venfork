import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { createMirrorFixture } from '../harness/mirror-fixture.js';

const LEAK_KEYS = [
  'GIT_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
] as const;
let sentinelDir: string | undefined;

afterEach(async () => {
  for (const key of LEAK_KEYS) delete process.env[key];
  if (sentinelDir) await rm(sentinelDir, { recursive: true, force: true });
  sentinelDir = undefined;
});

describe('mirror fixture isolation', () => {
  test('ignores and restores GIT_DIR and GIT_CONFIG_* from the parent process', async () => {
    sentinelDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-sentinel-'));
    const sentinel = path.join(sentinelDir, 'sentinel.git');
    await $`git init --quiet --bare ${sentinel}`;
    process.env.GIT_DIR = sentinel;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.name';
    process.env.GIT_CONFIG_VALUE_0 = 'Leaked Identity';

    const fx = await createMirrorFixture();
    let inside: Record<string, string | undefined>;
    let author: string;
    try {
      inside = Object.fromEntries(LEAK_KEYS.map((k) => [k, process.env[k]]));
      await fx.commitOnUpstream({ 'src/x.txt': 'x\n' });
      author = await fx.git(fx.upstream, 'log', '-1', '--format=%an', 'main');
    } finally {
      await fx.cleanup();
    }

    expect(inside).toEqual({
      GIT_DIR: undefined,
      GIT_CONFIG_COUNT: undefined,
      GIT_CONFIG_KEY_0: undefined,
      GIT_CONFIG_VALUE_0: undefined,
    });
    expect(author).toBe('Venfork Test');
    expect(process.env.GIT_DIR).toBe(sentinel);
    expect(process.env.GIT_CONFIG_VALUE_0).toBe('Leaked Identity');
    const refs = await $({
      env: { GIT_DIR: sentinel },
    })`git for-each-ref`;
    expect(refs.stdout).toBe('');
  });

  test('a failed fixture build restores the environment and removes its directory', async () => {
    process.env.GIT_DIR = '/parent/.git';
    const fixtureDirs = async () =>
      (await readdir(os.tmpdir())).filter((name) =>
        name.startsWith('venfork-fixture-')
      );
    const before = await fixtureDirs();

    await expect(
      createMirrorFixture({ defaultBranch: 'bad..name' })
    ).rejects.toThrow();

    expect(process.env.GIT_DIR).toBe('/parent/.git');
    expect(await fixtureDirs()).toEqual(before);
  });
});

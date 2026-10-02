import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { envWithoutIsolatedKeys } from '../harness/env.js';
import { createMirrorFixture } from '../harness/mirror-fixture.js';

const LEAK_KEYS = [
  'GIT_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
] as const;
let savedEnv: Map<string, string | undefined>;
let scratchDir: string | undefined;

beforeEach(() => {
  savedEnv = new Map(LEAK_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  scratchDir = undefined;
});

describe('mirror fixture isolation', () => {
  test('ignores and restores GIT_DIR and GIT_CONFIG_* from the parent process', async () => {
    scratchDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-sentinel-'));
    const sentinel = path.join(scratchDir, 'sentinel.git');
    await $({
      env: envWithoutIsolatedKeys(),
      extendEnv: false,
    })`git init --quiet --bare ${sentinel}`;
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
    scratchDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-tmproot-'));
    process.env.GIT_DIR = '/parent/.git';

    await expect(
      createMirrorFixture({ defaultBranch: 'bad..name', tmpRoot: scratchDir })
    ).rejects.toThrow();

    expect(process.env.GIT_DIR).toBe('/parent/.git');
    expect(await readdir(scratchDir)).toEqual([]);
  });

  test('builds the fixture under tmpRoot', async () => {
    scratchDir = await mkdtemp(path.join(os.tmpdir(), 'venfork-tmproot-'));
    const fx = await createMirrorFixture({ tmpRoot: scratchDir });
    try {
      expect(path.dirname(fx.root)).toBe(scratchDir);
    } finally {
      await fx.cleanup();
    }
    expect(await readdir(scratchDir)).toEqual([]);
  });

  test('refuses to clean up nested fixtures out of order', async () => {
    const outer = await createMirrorFixture();
    const inner = await createMirrorFixture();
    try {
      await expect(outer.cleanup()).rejects.toThrow(
        'cleaned up in reverse order of creation'
      );
    } finally {
      await inner.cleanup();
      await outer.cleanup();
    }
  });
});

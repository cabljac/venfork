import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { preserveCommand, syncCommand } from '../../src/commands.js';
import { readVenforkConfigFromRepo } from '../../src/config.js';
import { ConfigError, SyncDivergenceError } from '../../src/errors.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';
import { seedPreserve } from '../harness/preserve.js';

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

function sync(): Promise<void> {
  return syncCommand(undefined, { cwd: fx.work, quiet: true });
}

async function syncError(): Promise<unknown> {
  return sync().then(
    () => null,
    (err: unknown) => err
  );
}

/** Origin carries docs/a.md in its managed commit, preserved by the config. */
async function preserveDocOnOrigin(): Promise<void> {
  await seedPreserve(fx, ['docs/a.md']);
  await fx.commitOnOrigin({ 'docs/a.md': 'mirror only\n' });
  await sync();
  expect(await fx.fileAt(fx.origin, 'main', 'docs/a.md')).toBe('mirror only\n');
}

describe('config fails closed', () => {
  test('a config branch with invalid JSON stops sync and leaves origin alone', async () => {
    await preserveDocOnOrigin();
    await fx.writeRawConfig('{ "version": "1", ');
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const originBefore = await fx.sha(fx.origin, 'main');

    const error = await syncError();

    expect(error).toBeInstanceOf(ConfigError);
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
    expect(await fx.fileAt(fx.origin, 'main', 'docs/a.md')).toBe(
      'mirror only\n'
    );
  });

  test('a config that fails validation is a ConfigError, not "no config"', async () => {
    await fx.writeRawConfig(JSON.stringify({ version: '1' }));

    await expect(readVenforkConfigFromRepo(fx.work)).rejects.toBeInstanceOf(
      ConfigError
    );
  });

  test('a missing config branch still reads as no config', async () => {
    await fx.git(
      fx.work,
      'push',
      '--quiet',
      'origin',
      ':refs/heads/venfork-config'
    );

    expect(await readVenforkConfigFromRepo(fx.work)).toBeNull();
  });

  test('an unreachable origin is a ConfigError', async () => {
    await fx.git(fx.work, 'remote', 'set-url', 'origin', `${fx.root}/gone.git`);

    await expect(readVenforkConfigFromRepo(fx.work)).rejects.toBeInstanceOf(
      ConfigError
    );
  });
});

describe('invalid preserve entries', () => {
  test('a glob entry written by an older venfork aborts sync and keeps the file', async () => {
    await preserveDocOnOrigin();
    const raw = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({ ...raw, preserve: ['docs/*.md'] })
    );
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const originBefore = await fx.sha(fx.origin, 'main');

    const error = await syncError();

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('docs/*.md');
    expect((error as Error).message).toContain(
      "venfork preserve remove 'docs/*.md'"
    );
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
    expect(await fx.fileAt(fx.origin, 'main', 'docs/a.md')).toBe(
      'mirror only\n'
    );
  });

  test('preserve remove deletes an invalid entry', async () => {
    const raw = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({ ...raw, preserve: ['docs/*.md', 'docs/a.md'] })
    );

    await preserveCommand('remove', ['docs/*.md']);

    expect((await fx.readRawConfig()).preserve).toEqual(['docs/a.md']);
  });
});

describe('invalid schedule cron', () => {
  test('sync refuses a config whose cron does not parse', async () => {
    const raw = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({
        ...raw,
        schedule: { enabled: true, cron: '*/0 * * * *' },
      })
    );
    const originBefore = await fx.sha(fx.origin, 'main');

    const error = await syncError();

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('*/0 * * * *');
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });
});

describe('managed commit classification', () => {
  test('a user commit that edits venfork-sync.yml and adds ci.yml is divergence', async () => {
    await fx.commitOnOrigin({
      '.github/workflows/ci.yml': 'name: ci\n',
      '.github/workflows/venfork-sync.yml': 'name: tweaked\n',
    });
    const originBefore = await fx.sha(fx.origin, 'main');

    const error = await syncError();

    expect(error).toBeInstanceOf(SyncDivergenceError);
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });
});

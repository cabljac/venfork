import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'execa';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import * as mirrorCommit from '../../src/shared/mirror-commit.js';

const real = { ...mirrorCommit };
let beforeBuild: (() => Promise<void>) | null = null;
let beforePush: (() => Promise<void>) | null = null;

/** Runs a one-shot hook installed by a test, then clears it. */
async function runHook(
  take: () => (() => Promise<void>) | null
): Promise<void> {
  const hook = take();
  if (hook) await hook();
}

mock.module('../../src/shared/mirror-commit.js', () => ({
  ...real,
  buildOriginTip: async (args: Parameters<typeof real.buildOriginTip>[0]) => {
    await runHook(() => {
      const hook = beforeBuild;
      beforeBuild = null;
      return hook;
    });
    return real.buildOriginTip(args);
  },
  pushBranchWithLease: async (
    args: Parameters<typeof real.pushBranchWithLease>[0]
  ) => {
    await runHook(() => {
      const hook = beforePush;
      beforePush = null;
      return hook;
    });
    return real.pushBranchWithLease(args);
  },
}));

import { syncCommand } from '../../src/commands.js';
import {
  readVenforkConfigFromRepo,
  updateVenforkConfig,
} from '../../src/config.js';
import { applyConfigChange } from '../../src/shared/config-change.js';
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
  beforeBuild = null;
  beforePush = null;
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
});

/** A second clone of the mirror, wired like the fixture's work clone. */
async function secondClone(): Promise<string> {
  const dir = path.join(fx.root, 'clone-b');
  await $`git clone --quiet ${fx.origin} ${dir}`;
  await fx.git(dir, 'remote', 'add', 'upstream', fx.upstream);
  if (fx.publicFork) {
    await fx.git(dir, 'remote', 'add', 'public', fx.publicFork);
  }
  await fx.git(dir, 'remote', 'set-url', '--push', 'upstream', 'DISABLE');
  return dir;
}

/** Installs a pre-receive hook on origin that runs `body` per ref. */
async function rejectOnOrigin(body: string): Promise<void> {
  const hook = path.join(fx.origin, 'hooks', 'pre-receive');
  await writeFile(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n${body}\ndone\nexit 0\n`
  );
  await chmod(hook, 0o755);
}

const setCron = (cwd: string, cron: string) =>
  applyConfigChange(cwd, { schedule: { enabled: true, cron } });

const configCron = async () =>
  (await readVenforkConfigFromRepo(fx.work))?.schedule?.cron;

const originCron = async () =>
  (await fx.fileAt(fx.origin, 'main', WF))?.match(/cron: '([^']*)'/)?.[1];

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => (err instanceof Error ? err : new Error(String(err)))
  );
}

test('a change written by another clone between read and write aborts without writing', async () => {
  const b = await secondClone();
  beforeBuild = async () => {
    await updateVenforkConfig(b, {
      schedule: { enabled: true, cron: '45 4 * * *' },
    });
  };
  const mainBefore = await fx.sha(fx.origin, 'main');

  const err = await rejection(setCron(fx.work, '0 * * * *'));

  expect(err.message).toContain('venfork-config changed on origin');
  expect(await configCron()).toBe('45 4 * * *');
  expect(await fx.sha(fx.origin, 'main')).toBe(mainBefore);
});

test('a full change from another clone between write and push survives', async () => {
  const b = await secondClone();
  beforePush = async () => {
    await setCron(b, '30 2 * * *');
  };

  const err = await rejection(setCron(fx.work, '0 * * * *'));

  expect(err.message).toContain('venfork-config changed concurrently');
  expect(await configCron()).toBe('30 2 * * *');
  expect(await originCron()).toBe('30 2 * * *');
  await syncCommand(undefined, { cwd: fx.work, quiet: true });
  expect(await originCron()).toBe('30 2 * * *');
});

test('a config-only change from another clone survives a failed push', async () => {
  const b = await secondClone();
  beforePush = async () => {
    await updateVenforkConfig(b, {
      schedule: { enabled: true, cron: '45 4 * * *' },
    });
    await rejectOnOrigin('[ "$ref" = refs/heads/main ] && exit 1');
  };
  const mainBefore = await fx.sha(fx.origin, 'main');

  const err = await rejection(setCron(fx.work, '0 * * * *'));

  expect(err.message).toContain('push to origin/main failed');
  expect(err.message).toContain('venfork-config changed concurrently');
  expect(err.message).toContain('run `venfork sync` once origin is reachable');
  expect(err.message).toContain(mainBefore);
  expect(await configCron()).toBe('45 4 * * *');
});

test('a failed rollback reports both errors and both states', async () => {
  const marker = path.join(fx.root, 'reject-config');
  await rejectOnOrigin(
    `[ "$ref" = refs/heads/main ] && exit 1\n[ "$ref" = refs/heads/venfork-config ] && [ -e '${marker}' ] && exit 1`
  );
  beforePush = async () => {
    await writeFile(marker, '');
  };
  const mainBefore = await fx.sha(fx.origin, 'main');

  const err = await rejection(setCron(fx.work, '0 * * * *'));

  const written = await fx.sha(fx.origin, 'venfork-config');
  expect(err.message).toContain('push to origin/main failed');
  expect(err.message).toContain('Rolling venfork-config back failed');
  expect(err.message).toContain(written);
  expect(err.message).toContain(mainBefore);
  expect(await configCron()).toBe('0 * * * *');
  expect(await fx.sha(fx.origin, 'main')).toBe(mainBefore);
});

test('a failed push restores the exact config commit that was read', async () => {
  const before = await fx.sha(fx.origin, 'venfork-config');
  await rejectOnOrigin('[ "$ref" = refs/heads/main ] && exit 1');

  const err = await rejection(setCron(fx.work, '0 * * * *'));

  expect(err.message).toContain('push to origin/main failed');
  expect(await fx.sha(fx.origin, 'venfork-config')).toBe(before);
});

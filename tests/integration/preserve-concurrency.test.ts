import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import * as config from '../../src/config.js';
import * as configChange from '../../src/shared/config-change.js';

const realConfig = { ...config };
const realConfigChange = { ...configChange };
let beforeConfigWrite: (() => Promise<void>) | null = null;
let beforeConfigChange: (() => Promise<void>) | null = null;

/** Runs a one-shot hook installed by a test, then clears it. */
async function runHook(
  take: () => (() => Promise<void>) | null
): Promise<void> {
  const hook = take();
  if (hook) await hook();
}

mock.module('../../src/config.js', () => ({
  ...realConfig,
  updateVenforkConfig: async (
    ...args: Parameters<typeof realConfig.updateVenforkConfig>
  ) => {
    await runHook(() => {
      const hook = beforeConfigWrite;
      beforeConfigWrite = null;
      return hook;
    });
    return realConfig.updateVenforkConfig(...args);
  },
}));

mock.module('../../src/shared/config-change.js', () => ({
  ...realConfigChange,
  applyConfigChange: async (
    ...args: Parameters<typeof realConfigChange.applyConfigChange>
  ) => {
    await runHook(() => {
      const hook = beforeConfigChange;
      beforeConfigChange = null;
      return hook;
    });
    return realConfigChange.applyConfigChange(...args);
  },
}));

import { preserveCommand, syncCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
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
  beforeConfigWrite = null;
  beforeConfigChange = null;
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
});

const sync = () => syncCommand(undefined, { cwd: fx.work, quiet: true });
const preserveList = async () =>
  ((await fx.readRawConfig()).preserve as string[] | undefined)?.sort();

describe('preserve changes are deltas on the list as written', () => {
  test('preserve remove keeps a file a teammate preserved meanwhile', async () => {
    await seedPreserve(fx, ['x.txt', 'y.txt']);
    await fx.commitOnOrigin({ 'x.txt': 'x\n', 'y.txt': 'y\n' });
    await sync();
    beforeConfigChange = async () => {
      await fx.commitOnOrigin({ 'z.txt': 'teammate work\n' });
      await seedPreserve(fx, ['z.txt']);
    };

    await preserveCommand('remove', ['x.txt']);

    expect(await preserveList()).toEqual(['y.txt', 'z.txt']);
    expect(await fx.fileAt(fx.origin, 'main', 'z.txt')).toBe('teammate work\n');
    expect(await fx.fileAt(fx.origin, 'main', 'y.txt')).toBe('y\n');
    expect(await fx.fileAt(fx.origin, 'main', 'x.txt')).toBeNull();
  });

  test('two preserve adds that cross keep both entries', async () => {
    await fx.commitOnOrigin({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    beforeConfigWrite = async () => {
      await seedPreserve(fx, ['b.txt']);
    };

    await preserveCommand('add', ['a.txt']);

    expect(await preserveList()).toEqual(['a.txt', 'b.txt']);
  });

  test('preserve remove of an entry that is not listed fails and writes nothing', async () => {
    await seedPreserve(fx, ['x.txt']);
    const before = await fx.sha(fx.origin, 'venfork-config');

    await expect(preserveCommand('remove', ['nope.txt'])).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(await fx.sha(fx.origin, 'venfork-config')).toBe(before);
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { approvalCommand, stageCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import { approvalMemoryPath } from '../../src/shared/approval-guard.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

let fx: MirrorFixture;
const originalCwd = process.cwd();

beforeEach(async () => {
  fx = await createMirrorFixture();
  process.chdir(fx.work);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fx.cleanup();
});

async function storedApproval(): Promise<unknown> {
  const raw = await fx.fileAt(
    fx.origin,
    'venfork-config',
    '.venfork/config.json'
  );
  return JSON.parse(raw ?? '{}').approval;
}

describe('stage approval', () => {
  test('a mirror with no approval field reads as off and warns', async () => {
    expect(await approvalCommand()).toEqual({ level: 'off' });
    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('The approval gate is off'),
      expect.anything()
    );
  });

  test('setting a level writes it to venfork-config on origin', async () => {
    expect(await approvalCommand('reviewed')).toEqual({ level: 'reviewed' });
    expect(await storedApproval()).toBe('reviewed');

    expect(await approvalCommand('two-person')).toEqual({
      level: 'two-person',
    });
    expect(await storedApproval()).toBe('two-person');
    expect(await approvalCommand()).toEqual({ level: 'two-person' });
  });

  test('off removes the field and prints the warning', async () => {
    await approvalCommand('two-person');

    expect(await approvalCommand('off')).toEqual({ level: 'off' });
    expect(await storedApproval()).toBeUndefined();
    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('venfork stage approval on'),
      expect.anything()
    );
  });
});

describe('lowering the level with stage approval', () => {
  const NO_TERMINAL = { yes: true, noInput: true };
  const AT_TERMINAL = { yes: true, noInput: false };

  async function cutFeature(): Promise<void> {
    await fx.git(
      fx.work,
      'checkout',
      '--quiet',
      '-b',
      'feature',
      'origin/main'
    );
    await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
    await fx.git(fx.work, 'add', 'src/feature.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: feature work');
  }

  const memory = async (): Promise<unknown> =>
    JSON.parse(await readFile(await approvalMemoryPath(fx.work), 'utf8'));

  const errorText = () =>
    (prompts.log.error as ReturnType<typeof mock>).mock.calls
      .map((c) => String(c[0]))
      .join('\n');

  test('raising the level records it in the clone memory', async () => {
    await approvalCommand('two-person', NO_TERMINAL);

    expect(await memory()).toEqual({ level: 'two-person' });
  });

  test('a person who confirms at a terminal is not asked again by stage', async () => {
    await approvalCommand('two-person');
    await cutFeature();

    await approvalCommand('off', AT_TERMINAL);

    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Lower approval from two-person to off?',
      })
    );
    expect(await memory()).toEqual({ level: 'off' });
    await stageCommand('feature', { prompt: NO_TERMINAL });
    expect(
      await fx.git(fx.publicFork ?? '', 'branch', '--list', 'feature')
    ).not.toBe('');
  });

  test('without a terminal the level is written and stage in this clone asks instead', async () => {
    await approvalCommand('two-person');
    await cutFeature();

    expect(await approvalCommand('off', NO_TERMINAL)).toEqual({
      level: 'off',
    });

    expect(await storedApproval()).toBeUndefined();
    expect(await memory()).toEqual({ level: 'two-person' });
    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('the next venfork stage in this clone asks'),
      expect.anything()
    );
    await expect(
      stageCommand('feature', { prompt: NO_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));
    expect(errorText()).toContain('this clone last saw two-person');
  });

  test('an unconfirmed lowering in a clone with no memory records the level it lowered from', async () => {
    const raw = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({ ...raw, approval: 'reviewed' }, null, 2)
    );

    await approvalCommand('off', NO_TERMINAL);

    expect(await memory()).toEqual({ level: 'reviewed' });
  });

  test('a config write during the confirm refuses, writes nothing and keeps the memory', async () => {
    await approvalCommand('two-person');
    (prompts.confirm as ReturnType<typeof mock>).mockImplementationOnce(
      async () => {
        const raw = await fx.readRawConfig();
        delete raw.approval;
        await fx.writeRawConfig(JSON.stringify(raw, null, 2));
        return true;
      }
    );

    await expect(approvalCommand('reviewed', AT_TERMINAL)).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(errorText()).toContain('changed on origin');
    expect(await storedApproval()).toBeUndefined();
    expect(await memory()).toEqual({ level: 'two-person' });
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { approvalCommand } from '../../src/commands.js';
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

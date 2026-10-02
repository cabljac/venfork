import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { statusCommand } from '../../src/commands.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

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

describe('status config warning', () => {
  test('warns instead of silently ignoring an unreadable venfork-config', async () => {
    await fx.writeRawConfig('{ not json');

    await statusCommand();

    expect(prompts.log.warn).toHaveBeenCalledTimes(1);
    expect(
      (prompts.log.warn as unknown as ReturnType<typeof mock>).mock.calls[0][0]
    ).toContain('Could not read venfork-config');
  });

  test('does not warn for a valid config', async () => {
    await statusCommand();

    expect(prompts.log.warn).not.toHaveBeenCalled();
  });
});

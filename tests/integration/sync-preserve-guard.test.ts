import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { syncCommand } from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

let fx: MirrorFixture;
let active: MirrorFixture | undefined;

beforeEach(async () => {
  fx = await createMirrorFixture();
  active = fx;
});

afterEach(async () => {
  await active?.cleanup();
  active = undefined;
});

describe('sync invalid-preserve guard ordering', () => {
  test('an invalid preserve entry wins over divergence and nothing is pushed', async () => {
    await updateVenforkConfig(fx.work, { preserve: ['src/file-*.txt'] });
    await fx.commitOnOrigin({ 'src/mirror-only.txt': 'diverged\n' });
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const originBefore = await fx.sha(fx.origin, 'main');
    const publicBefore = await fx.sha(fx.publicFork as string, 'main');

    const failure = await syncCommand(undefined, {
      cwd: fx.work,
      quiet: true,
    }).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).message).toContain('src/file-*.txt');
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
    expect(await fx.sha(fx.publicFork as string, 'main')).toBe(publicBefore);
  });
});

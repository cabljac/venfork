import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand } from '../../src/commands.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

let fx: MirrorFixture;
const originalCwd = process.cwd();
const originalExit = process.exit;

beforeEach(async () => {
  fx = await createMirrorFixture();
  process.exit = mock((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  process.chdir(fx.work);
});

afterEach(async () => {
  process.exit = originalExit;
  process.chdir(originalCwd);
  await fx.cleanup();
});

async function cutFeatureBranch(base: string): Promise<string> {
  await fx.git(fx.work, 'fetch', '--quiet', 'origin');
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature', base);
  await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
  await fx.git(fx.work, 'add', 'src/feature.txt');
  await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: feature work');
  return fx.sha(fx.work, 'feature');
}

describe('stage against real repos', () => {
  test('stage pushes a branch with no managed commit unchanged', async () => {
    const featureSha = await cutFeatureBranch('upstream/main');

    await stageCommand('feature');

    expect(await fx.sha(fx.publicFork ?? '', 'feature')).toBe(featureSha);
  });
});

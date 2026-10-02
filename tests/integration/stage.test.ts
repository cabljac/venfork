import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import {
  preserveCommand,
  stageCommand,
  syncCommand,
} from '../../src/commands.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

const CALLER = '.github/workflows/caller.yml';

let fx: MirrorFixture;
let active: MirrorFixture | undefined;
const originalCwd = process.cwd();
const originalExit = process.exit;

beforeEach(async () => {
  fx = await createMirrorFixture();
  active = fx;
  process.exit = mock((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  process.chdir(fx.work);
});

afterEach(async () => {
  process.exit = originalExit;
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
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
  test('stage strips a preserve-only managed commit', async () => {
    await preserveCommand('add', [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand(undefined, { cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');

    await stageCommand('feature');

    const publicFork = fx.publicFork ?? '';
    const upstreamTip = await fx.sha(fx.upstream, 'main');
    expect(await fx.subjects(publicFork, 'feature', 'main..feature')).toEqual([
      'feat: feature work',
    ]);
    expect(await fx.sha(publicFork, 'feature~1')).toBe(upstreamTip);
    expect(await fx.fileAt(publicFork, 'feature', CALLER)).toBeNull();
    expect(await fx.fileAt(publicFork, 'feature', 'src/feature.txt')).toBe(
      'feature\n'
    );
  });

  test('stage pushes a branch with no managed commit unchanged', async () => {
    const featureSha = await cutFeatureBranch('upstream/main');

    await stageCommand('feature');

    expect(await fx.sha(fx.publicFork ?? '', 'feature')).toBe(featureSha);
  });

  test('stage re-pushes a rebuilt branch when the public tracking ref is missing', async () => {
    await preserveCommand('add', [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand(undefined, { cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');
    await stageCommand('feature');
    await fx.git(fx.work, 'commit', '--quiet', '--amend', '-m', 'feat: v2');
    await fx.git(fx.work, 'update-ref', '-d', 'refs/remotes/public/feature');

    await stageCommand('feature');

    expect(
      await fx.subjects(fx.publicFork ?? '', 'feature', 'main..feature')
    ).toEqual(['feat: v2']);
  });

  test('stage names the preserved path when a commit touching it cannot be replayed', async () => {
    await preserveCommand('add', [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand(undefined, { cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');
    await Bun.write(`${fx.work}/${CALLER}`, 'edited on the branch\n');
    await fx.git(fx.work, 'commit', '--quiet', '-am', 'chore: tweak caller');

    await expect(stageCommand('feature')).rejects.toThrow('process.exit(1)');

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(`preserved mirror-only path(s) ${CALLER}`)
    );
  });
});

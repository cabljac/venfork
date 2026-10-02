import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chmod } from 'node:fs/promises';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
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

async function cutFeatureBranch(base: string): Promise<string> {
  await fx.git(fx.work, 'fetch', '--quiet', 'origin');
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature', base);
  await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
  await fx.git(fx.work, 'add', 'src/feature.txt');
  await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: feature work');
  return fx.sha(fx.work, 'feature');
}

describe('stage against real repos', () => {
  test('a post-checkout hook in the clone does not leak into the staged branch', async () => {
    await preserveCommand('add', [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand(undefined, { cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');
    const hook = `${fx.work}/.git/hooks/post-checkout`;
    await Bun.write(
      hook,
      '#!/bin/sh\necho hooked > hooked.txt\ngit add hooked.txt\n'
    );
    await chmod(hook, 0o755);

    await stageCommand('feature');

    expect(
      await fx.fileAt(fx.publicFork ?? '', 'feature', 'hooked.txt')
    ).toBeNull();
  });

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

const DOC = 'docs/a.md';

/** The bare repo stage pushes to in the current fixture's mode. */
function pushTarget(): string {
  return fx.publicFork ?? fx.upstream;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  const result = await $({
    cwd: repo,
    reject: false,
  })`git rev-parse --verify --quiet ${ref}`;
  return result.exitCode === 0;
}

async function useMode(mode: 'standard' | 'no-public'): Promise<void> {
  if (mode === 'standard') return;
  process.chdir(originalCwd);
  await active?.cleanup();
  fx = await createMirrorFixture({ mode });
  active = fx;
  process.chdir(fx.work);
}

async function expectLeakRefused(): Promise<void> {
  await expect(stageCommand('feature')).rejects.toThrow('process.exit(1)');
  expect(prompts.log.error).toHaveBeenCalledWith(
    expect.stringContaining(`mirror-only path(s) ${DOC}`)
  );
  expect(await refExists(pushTarget(), 'refs/heads/feature')).toBe(false);
}

describe.each(['standard', 'no-public'] as const)(
  'stage refuses to publish mirror-only paths (%s)',
  (mode) => {
    beforeEach(async () => {
      await useMode(mode);
      await preserveCommand('add', [DOC]);
    });

    test('a branch cut before sync from a teammate commit of a preserved file', async () => {
      await fx.commitOnOrigin({ [DOC]: 'mirror only\n' });
      await cutFeatureBranch('origin/main');

      await expectLeakRefused();
    });

    test('a branch squashed onto upstream after sync', async () => {
      await fx.commitOnOrigin({ [DOC]: 'mirror only\n' });
      await syncCommand(undefined, { cwd: fx.work, quiet: true });
      await cutFeatureBranch('origin/main');
      await fx.git(fx.work, 'reset', '--quiet', '--soft', 'upstream/main');
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: squashed');

      await expectLeakRefused();
    });

    test('a cherry-picked commit that adds a preserved file', async () => {
      const teammate = await fx.commitOnOrigin({ [DOC]: 'mirror only\n' });
      await cutFeatureBranch('upstream/main');
      await fx.git(fx.work, 'cherry-pick', teammate);

      await expectLeakRefused();
    });
  }
);

describe('stage refuses branches that are not upstream work', () => {
  test('the venfork-config branch', async () => {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(fx.work, 'branch', 'venfork-config', 'origin/venfork-config');

    await expect(stageCommand('venfork-config')).rejects.toThrow(
      'process.exit(1)'
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('venfork-config')
    );
    expect(await refExists(pushTarget(), 'refs/heads/venfork-config')).toBe(
      false
    );
  });

  test('a branch with no history in common with upstream', async () => {
    await fx.git(fx.work, 'checkout', '--quiet', '--orphan', 'lonely');
    await Bun.write(`${fx.work}/lonely.txt`, 'alone\n');
    await fx.git(fx.work, 'add', 'lonely.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: lonely');

    await expect(stageCommand('lonely')).rejects.toThrow('process.exit(1)');

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('no history in common with upstream/main')
    );
    expect(await refExists(pushTarget(), 'refs/heads/lonely')).toBe(false);
  });
});

describe('stage in no-public mode', () => {
  test('pushes a clean branch straight to upstream', async () => {
    await useMode('no-public');
    const featureSha = await cutFeatureBranch('upstream/main');

    await stageCommand('feature');

    expect(await fx.sha(fx.upstream, 'feature')).toBe(featureSha);
  });
});

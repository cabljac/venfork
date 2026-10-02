import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { seedPreserve } from '../harness/preserve.js';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand, syncCommand } from '../../src/commands.js';
import { collectMirrorBlobs } from '../../src/shared/stage-gate.js';
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
  delete process.env.VENFORK_ALLOW_SELF_REFERENCE;
  await fx.cleanup();
});

const git = (...args: string[]) => fx.git(fx.work, ...args);
const sync = () => syncCommand(undefined, { cwd: fx.work, quiet: true });

async function featureFrom(base: string): Promise<void> {
  await git('fetch', '--quiet', 'origin');
  await git('fetch', '--quiet', 'upstream');
  await git('checkout', '--quiet', '-b', 'feature', base);
}

async function commitFile(
  file: string,
  content: string | Buffer,
  message: string
): Promise<void> {
  await Bun.write(`${fx.work}/${file}`, content);
  await git('add', '--', file);
  await git('commit', '--quiet', '-m', message);
}

async function published(): Promise<boolean> {
  const result = await $({
    cwd: fx.publicFork ?? '',
    reject: false,
  })`git rev-parse --verify --quiet refs/heads/feature`;
  return result.exitCode === 0;
}

async function expectRefused(...messages: string[]): Promise<void> {
  await expect(stageCommand('feature')).rejects.toThrow('process.exit(1)');
  for (const message of messages) {
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(message)
    );
  }
  expect(await published()).toBe(false);
}

async function expectShipped(): Promise<void> {
  await stageCommand('feature');
  expect(await published()).toBe(true);
}

function warnings(): string[] {
  return (
    prompts.log.warn as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.map((call) => String(call[0]));
}

/** Moves `ref` through `count` new commits on its tree, then back, as reflog entries. */
async function growReflog(ref: string, count: number): Promise<void> {
  const tip = await git('rev-parse', ref);
  const tree = await git('rev-parse', `${tip}^{tree}`);
  let parent = tip;
  for (let i = 0; i < count; i++) {
    parent = await git('commit-tree', tree, '-p', parent, '-m', `x${i}`);
    await git('update-ref', ref, parent);
  }
  await git('update-ref', ref, tip);
}

describe('collectMirrorBlobs scales with history', () => {
  test('reads 10 preserved files across 300 reflog entries in under 5 s', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`keep/f${i}.txt`] = `kept ${i}\n`;
    await fx.commitOnOrigin(files);
    await seedPreserve(fx, Object.keys(files));
    await sync();
    await git('fetch', '--quiet', 'origin');
    await growReflog('refs/remotes/origin/main', 300);

    const started = Date.now();
    const { blobs } = await collectMirrorBlobs(
      ['refs/remotes/origin/main', 'refs/heads/main'],
      Object.keys(files),
      'upstream/main',
      fx.work
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5000);
    expect(
      [...blobs.values()].filter((p) => p.startsWith('keep/')).sort()
    ).toEqual(Object.keys(files).sort());
  });

  test('warns when the history cap is hit', async () => {
    await fx.commitOnOrigin({ 'keep/a.txt': 'kept\n' });
    await seedPreserve(fx, ['keep/a.txt']);
    await sync();
    await git('fetch', '--quiet', 'origin');
    await growReflog('refs/remotes/origin/main', 10);

    const { warnings: found } = await collectMirrorBlobs(
      ['refs/remotes/origin/main'],
      ['keep/a.txt'],
      'upstream/main',
      fx.work,
      { historyCap: 3 }
    );

    expect(found.join('\n')).toContain(
      'mirror-only history older than that cannot be checked'
    );
  });

  test('stage warns when the reflog of origin/main is empty', async () => {
    await git('reflog', 'expire', '--expire=now', '--all');
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', 'feat: a');

    await expectShipped();

    expect(warnings().join('\n')).toContain(
      'refs/remotes/origin/main has no reflog'
    );
  });
});

describe('upstream history is not mirror content', () => {
  test('an old upstream version of a preserved file ships at another path', async () => {
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 80\n' });
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 8080\n' });
    await sync();
    await seedPreserve(fx, ['config/app.yml']);
    await featureFrom('upstream/main');
    await commitFile('examples/app.yml', 'port: 80\n', 'docs: example');

    await expectShipped();
  });

  test('a mirror-only version of an upstream path copied elsewhere is still refused', async () => {
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 80\n' });
    await sync();
    await fx.commitOnOrigin({ 'config/app.yml': 'port: 9999 secret\n' });
    await seedPreserve(fx, ['config/app.yml']);
    await featureFrom('upstream/main');
    await commitFile('examples/app.yml', 'port: 9999 secret\n', 'docs: x');

    await expectRefused('examples/app.yml (content of config/app.yml)');
  });
});

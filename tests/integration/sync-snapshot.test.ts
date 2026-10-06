import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import * as divergence from '../../src/shared/divergence.js';
import * as net from '../../src/shared/net.js';

const realDivergence = { ...divergence };
const realNet = { ...net };
let afterDivergenceCheck: (() => Promise<void>) | null = null;
let beforeUpstreamFetch: (() => Promise<void>) | null = null;

/** Runs a one-shot hook installed by a test, then clears it. */
async function runHook(
  take: () => (() => Promise<void>) | null
): Promise<void> {
  const hook = take();
  if (hook) await hook();
}

mock.module('../../src/shared/divergence.js', () => ({
  ...realDivergence,
  checkDivergence: async (
    args: Parameters<typeof realDivergence.checkDivergence>[0]
  ) => {
    const result = await realDivergence.checkDivergence(args);
    await runHook(() => {
      const hook = afterDivergenceCheck;
      afterDivergenceCheck = null;
      return hook;
    });
    return result;
  },
}));

mock.module('../../src/shared/net.js', () => ({
  ...realNet,
  netFetch: async (remote: string, cwd?: string) => {
    if (remote === 'upstream') {
      await runHook(() => {
        const hook = beforeUpstreamFetch;
        beforeUpstreamFetch = null;
        return hook;
      });
    }
    return realNet.netFetch(remote, cwd);
  },
}));

import { syncCommand } from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
import { SyncDivergenceError } from '../../src/errors.js';
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
});

afterEach(async () => {
  afterDivergenceCheck = null;
  beforeUpstreamFetch = null;
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
});

function sync(cwd = fx.work): Promise<void> {
  return syncCommand(undefined, { cwd, quiet: true });
}

/** A second developer clone of the mirror with every remote wired up. */
async function teammateClone(): Promise<string> {
  const work2 = path.join(fx.root, 'work2');
  await fx.git(fx.root, 'clone', '--quiet', fx.origin, work2);
  await fx.git(work2, 'remote', 'add', 'upstream', fx.upstream);
  await fx.git(work2, 'remote', 'set-url', '--push', 'upstream', 'DISABLE');
  if (fx.publicFork) {
    await fx.git(work2, 'remote', 'add', 'public', fx.publicFork);
    await fx.git(work2, 'fetch', '--quiet', 'public');
  }
  await fx.git(work2, 'fetch', '--quiet', 'upstream');
  return work2;
}

describe('sync works from one snapshot of origin', () => {
  test('a fetch between the divergence check and the push cannot drop a commit', async () => {
    await updateVenforkConfig(fx.work, {
      schedule: { enabled: true, cron: '0 * * * *' },
    });
    await sync();
    await fx.commitOnUpstream({ 'src/up.txt': 'up\n' });
    let teammateTip = '';
    afterDivergenceCheck = async () => {
      teammateTip = await fx.commitOnOrigin(
        { 'teammate.txt': 'teammate\n' },
        'feat: teammate work'
      );
      await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    };

    await expect(sync()).rejects.toThrow('process.exit(1)');

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('moved since this sync fetched it')
    );
    expect(await fx.sha(fx.origin, 'main')).toBe(teammateTip);
    expect(await fx.fileAt(fx.origin, 'main', 'teammate.txt')).toBe(
      'teammate\n'
    );
  });

  test('the config is read after origin is fetched, so a fresh preserve entry is honoured', async () => {
    await seedPreserve(fx, ['tools/p.txt']);
    await fx.commitOnOrigin({ 'tools/p.txt': 'p\n' });
    await sync();
    const work2 = await teammateClone();
    beforeUpstreamFetch = async () => {
      await fx.commitOnOrigin({ 'tools/q.txt': 'only copy of q\n' });
      await seedPreserve(fx, ['tools/q.txt']);
      await sync(work2);
    };

    await sync();

    expect(await fx.fileAt(fx.origin, 'main', 'tools/q.txt')).toBe(
      'only copy of q\n'
    );
    expect(await fx.fileAt(fx.origin, 'main', 'tools/p.txt')).toBe('p\n');
    await expect(sync()).resolves.toBeUndefined();
  });
});

describe('a preserved path upstream also has belongs to upstream', () => {
  test('a mirror edit to it is divergence, not a preserved-only commit', async () => {
    await seedPreserve(fx, ['docs/runbook.md']);
    await fx.commitOnOrigin({ 'docs/runbook.md': 'mirror v1\n' });
    await sync();
    await fx.commitOnUpstream({ 'docs/runbook.md': 'upstream v1\n' });
    await sync();
    const edited = await fx.commitOnOrigin(
      { 'docs/runbook.md': 'mirror v2\n' },
      'docs: internal runbook update'
    );
    await fx.commitOnUpstream({ 'src/other.txt': 'x\n' });

    await expect(sync()).rejects.toBeInstanceOf(SyncDivergenceError);

    expect(await fx.sha(fx.origin, 'main')).toBe(edited);
    expect(await fx.fileAt(fx.origin, 'main', 'docs/runbook.md')).toBe(
      'mirror v2\n'
    );
  });

  test('a mirror edit that matches upstream again is not divergence', async () => {
    await seedPreserve(fx, ['docs/runbook.md']);
    await fx.commitOnOrigin({ 'docs/runbook.md': 'mirror v1\n' });
    await sync();
    await fx.commitOnUpstream({ 'docs/runbook.md': 'upstream v1\n' });
    await sync();
    await fx.commitOnOrigin({ 'docs/runbook.md': 'mirror v2\n' });
    await fx.commitOnOrigin({ 'docs/runbook.md': 'upstream v1\n' });

    await expect(sync()).resolves.toBeUndefined();

    expect(await fx.fileAt(fx.origin, 'main', 'docs/runbook.md')).toBe(
      'upstream v1\n'
    );
  });
});

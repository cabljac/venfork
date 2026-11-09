import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { ON_STDERR, quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import {
  type DoctorCheck,
  runDoctorChecks,
  syncCommand,
} from '../../src/commands.js';
import { trackedBranchesOf, updateVenforkConfig } from '../../src/config.js';
import {
  type AcceptedRewrite,
  pushTrackedBranches,
  readTrackedBranches,
} from '../../src/shared/tracked-branches.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';
import { seedPreserve } from '../harness/preserve.js';

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

function sync(acceptRewrites?: AcceptedRewrite[]) {
  return syncCommand({
    cwd: fx.work,
    quiet: true,
    ...(acceptRewrites ? { acceptRewrites } : {}),
  });
}

async function track(trackedBranches: unknown): Promise<void> {
  await updateVenforkConfig(fx.work, { trackedBranches });
}

/** Points upstream's `ga` at a new commit on the default branch, as a rebase would. */
async function rewriteUpstreamGa(): Promise<string> {
  await fx.git(fx.work, 'fetch', '--quiet', 'upstream');
  await fx.git(fx.work, 'checkout', '--quiet', '-B', 'rw', 'upstream/main');
  await Bun.write(`${fx.work}/src/rewritten.txt`, 'rewritten\n');
  await fx.git(fx.work, 'add', 'src/rewritten.txt');
  await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: rewritten ga');
  await fx.git(fx.work, 'push', '--quiet', fx.upstream, '+rw:refs/heads/ga');
  await fx.git(fx.work, 'checkout', '--quiet', 'main');
  return fx.sha(fx.upstream, 'ga');
}

async function originGa(): Promise<string | null> {
  return fx.sha(fx.origin, 'ga').catch(() => null);
}

async function trackedRow(): Promise<DoctorCheck | undefined> {
  const checks = await runDoctorChecks({ cwd: fx.work });
  return checks.find((check) => check.id === 'tracked');
}

describe('sync with trackedBranches', () => {
  test('without trackedBranches, sync reports none and doctor has no tracked row', async () => {
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });

    const result = await sync();

    expect(result).not.toHaveProperty('trackedBranches');
    expect(await originGa()).toBeNull();
    expect(await trackedRow()).toBeUndefined();
  });

  test('creates origin/<branch> from upstream and leaves the public fork alone', async () => {
    const tip = await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track(['ga']);

    const result = await sync();

    expect(result).toMatchObject({
      status: 'pushed',
      trackedBranches: [{ name: 'ga', status: 'created', tip }],
    });
    expect(await originGa()).toBe(tip);
    expect(
      await fx.sha(fx.publicFork ?? '', 'ga').catch(() => null)
    ).toBeNull();
  });

  test('fast-forwards origin/<branch>, then reports it up to date', async () => {
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track(['ga']);
    await sync();
    const tip = await fx.commitOnUpstreamBranch('ga', {
      'src/ga.txt': 'ga 2\n',
    });

    expect(await trackedRow()).toMatchObject({
      ok: true,
      detail: 'ga behind upstream; the next sync fast-forwards it',
    });
    const first = await sync();
    const second = await sync();

    expect(first).toMatchObject({
      trackedBranches: [{ name: 'ga', status: 'fast-forwarded', tip }],
    });
    expect(second).toMatchObject({
      status: 'up-to-date',
      trackedBranches: [{ name: 'ga', status: 'up-to-date', tip }],
    });
    expect(await fx.pushCount(fx.origin, 'refs/heads/ga')).toBe(2);
    expect(await trackedRow()).toMatchObject({
      ok: true,
      detail: 'ga up to date',
    });
  });

  test('a rewritten upstream branch is left as is and reported, and the default branch still syncs', async () => {
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track(['ga']);
    await sync();
    const before = (await originGa()) ?? '';
    const mainTip = await fx.commitOnUpstream({
      'src/main-later.txt': 'later\n',
    });
    const rewritten = await rewriteUpstreamGa();

    const result = await sync();

    expect(result).toMatchObject({
      status: 'pushed',
      origin: { tip: mainTip, pushed: true },
      public: { tip: mainTip, pushed: true },
      trackedBranches: [
        { name: 'ga', status: 'diverged', tip: before, upstreamTip: rewritten },
      ],
    });
    expect(result.trackedBranches?.[0]).not.toHaveProperty('command');
    expect(await originGa()).toBe(before);
    expect(await fx.sha(fx.origin, 'main')).toBe(mainTip);
    expect(await fx.sha(fx.publicFork ?? '', 'main')).toBe(mainTip);
    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Tracked branch ga not synced'),
      ON_STDERR
    );
    expect(await trackedRow()).toMatchObject({
      ok: false,
      detail: 'origin/ga is not an ancestor of upstream/ga',
      fix: expect.stringContaining('"allowRewrite": "explicit"'),
    });
  });

  test('allowRewrite explicit replaces the branch only with a matching --accept-rewrite', async () => {
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track([{ name: 'ga', allowRewrite: 'explicit' }]);
    await sync();
    const old = (await originGa()) ?? '';
    const rewritten = await rewriteUpstreamGa();
    const command = `venfork sync --accept-rewrite ga=${old}..${rewritten}`;

    expect(await sync()).toMatchObject({
      trackedBranches: [{ name: 'ga', status: 'diverged', command }],
    });
    expect(await trackedRow()).toMatchObject({
      ok: false,
      fix: expect.stringContaining(command.replace('venfork sync ', '')),
    });
    await expect(
      sync([{ branch: 'ga', from: rewritten, to: rewritten }])
    ).rejects.toMatchObject({
      cause: {
        code: 'precondition',
        hint: expect.stringContaining(command),
      },
    });
    expect(await originGa()).toBe(old);

    const result = await sync([{ branch: 'ga', from: old, to: rewritten }]);

    expect(result).toMatchObject({
      trackedBranches: [
        { name: 'ga', status: 'rewritten', tip: rewritten, previous: old },
      ],
    });
    expect(await originGa()).toBe(rewritten);
  });

  test('a wrong --accept-rewrite refuses before anything is pushed', async () => {
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track(['ga', { name: 'rc', allowRewrite: 'explicit' }]);
    await fx.commitOnUpstreamBranch('rc', { 'src/rc.txt': 'rc\n' });
    await sync();
    const mainBefore = await fx.sha(fx.origin, 'main');
    await fx.commitOnUpstream({ 'src/main-later.txt': 'later\n' });
    const ga = (await originGa()) ?? '';
    const rc = await fx.sha(fx.origin, 'rc');
    const sha = 'a'.repeat(40);

    for (const [rewrite, message] of [
      [{ branch: 'nope', from: sha, to: sha }, 'trackedBranches does not list'],
      [{ branch: 'ga', from: ga, to: ga }, 'does not set "allowRewrite"'],
      [{ branch: 'rc', from: rc, to: rc }, 'has not diverged'],
    ] as const) {
      await expect(sync([rewrite])).rejects.toMatchObject({
        cause: {
          code: 'precondition',
          message: expect.stringContaining(message),
        },
      });
    }
    expect(await fx.sha(fx.origin, 'main')).toBe(mainBefore);
  });

  test('a tracked branch that moves on origin between the read and the push fails on the lease', async () => {
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track(['ga']);
    await sync();
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga 2\n' });
    await fx.git(fx.work, 'fetch', '--quiet', 'upstream');
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    const plans = await readTrackedBranches(
      trackedBranchesOf(await fx.readRawConfig()),
      'main',
      fx.work
    );
    expect(plans[0]).toMatchObject({ state: 'behind' });
    await fx.git(fx.work, 'checkout', '--quiet', '-B', 'moved', 'origin/ga');
    await fx.git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', 'x');
    await fx.git(fx.work, 'push', '--quiet', 'origin', 'moved:ga');
    const moved = await fx.sha(fx.origin, 'ga');

    await expect(pushTrackedBranches(plans, [], fx.work)).rejects.toThrow(
      'origin/ga moved since this sync fetched it'
    );
    expect(await fx.sha(fx.origin, 'ga')).toBe(moved);
  });

  test('a tracked branch upstream does not have is reported, and doctor says so', async () => {
    await track(['ga']);

    expect(await sync()).toMatchObject({
      trackedBranches: [{ name: 'ga', status: 'no-upstream' }],
    });
    expect(await trackedRow()).toMatchObject({
      ok: false,
      detail: 'upstream/ga not found',
    });
  });

  test('an invalid trackedBranches entry refuses sync', async () => {
    await track([{ name: 'ga', allowRewrite: 'always' }]);

    await expect(sync()).rejects.toMatchObject({ code: 'config' });
  });
});

describe('doctor tracked-kept', () => {
  const CALLER = '.github/workflows/caller.yml';

  async function commitOnOriginGa(files: Record<string, string>) {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(fx.work, 'checkout', '--quiet', '-B', 'ga', 'origin/ga');
    for (const [file, content] of Object.entries(files)) {
      await Bun.write(`${fx.work}/${file}`, content);
      await fx.git(fx.work, 'add', file);
    }
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'chore: on mirror ga');
    await fx.git(fx.work, 'push', '--quiet', 'origin', 'ga');
    await fx.git(fx.work, 'checkout', '--quiet', 'main');
  }

  async function keptRow(): Promise<DoctorCheck | undefined> {
    const checks = await runDoctorChecks({ cwd: fx.work });
    return checks.find((check) => check.id === 'tracked-kept');
  }

  test('a tracked branch equal to upstream carries no mirror-only files', async () => {
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track(['ga']);
    await sync();

    expect(await keptRow()).toMatchObject({
      ok: true,
      detail: 'no kept or venfork files on tracked branches',
    });
  });

  test('a kept file or venfork file on origin/<branch> fails, naming each', async () => {
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await fx.commitOnUpstreamBranch('ga', { 'src/ga.txt': 'ga\n' });
    await track(['ga']);
    await sync();
    await commitOnOriginGa({
      [CALLER]: 'mirror only\n',
      '.venfork/notes.json': '{}\n',
      'src/other.txt': 'not kept\n',
    });

    const row = await keptRow();

    expect(row).toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        `origin/ga: .github/workflows/caller.yml, .venfork/notes.json`
      ),
    });
    expect(String(row?.detail)).not.toContain('src/other.txt');
  });

  test('a kept path whose content upstream/<branch> also has is not mirror-only', async () => {
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await fx.commitOnUpstreamBranch('ga', { [CALLER]: 'upstream too\n' });
    await track(['ga']);
    await sync();

    expect(await keptRow()).toMatchObject({ ok: true });
  });
});

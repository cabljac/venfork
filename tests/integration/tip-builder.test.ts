import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'execa';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { syncCommand } from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
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
  process.chdir(fx.work);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
});

const sync = () => syncCommand(undefined, { cwd: fx.work, quiet: true });

function enableSchedule(extra: Record<string, unknown> = {}) {
  return updateVenforkConfig(fx.work, {
    schedule: { enabled: true, cron: '0 * * * *' },
    ...extra,
  });
}

/** Resets origin/main to upstream so the next sync rebuilds the managed commit. */
async function resetOriginToUpstream(): Promise<void> {
  await fx.git(
    fx.work,
    'push',
    '--quiet',
    '--force',
    'origin',
    'upstream/main:refs/heads/main'
  );
}

/** Commits arbitrary filesystem changes made by `fn` on upstream. */
async function commitRawOnUpstream(
  fn: (dir: string) => Promise<void>,
  message = 'feat: raw upstream change'
): Promise<void> {
  const dir = path.join(fx.root, 'upstream-dev');
  await fx.git(dir, 'pull', '--quiet', '--ff-only');
  await fn(dir);
  await fx.git(dir, 'add', '-A');
  await $({
    cwd: dir,
    env: {
      GIT_AUTHOR_DATE: '@1750000000 +0000',
      GIT_COMMITTER_DATE: '@1750000000 +0000',
    },
  })`git commit --quiet -m ${message}`;
  await fx.git(dir, 'push', '--quiet', 'origin', 'main');
}

function workflowNames(ref = 'main'): Promise<string> {
  return fx.git(
    fx.origin,
    '-c',
    'core.quotePath=false',
    'ls-tree',
    '-r',
    '--name-only',
    ref,
    '--',
    '.github/workflows'
  );
}

/** Sets one git config value for every git process this test spawns. */
function gitConfigEnv(key: string, value: string): void {
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = key;
  process.env.GIT_CONFIG_VALUE_0 = value;
}

describe('workflow filtering by exact name', () => {
  test('a blocked non-ASCII workflow is removed and the SHA ignores core.quotePath', async () => {
    await fx.commitOnUpstream({
      '.github/workflows/dé.yml': 'x\n',
      '.github/workflows/ci.yml': 'ci\n',
    });
    await enableSchedule({ disabledWorkflows: ['dé.yml'] });
    await sync();
    const quoted = await fx.sha(fx.origin, 'main');
    await resetOriginToUpstream();
    gitConfigEnv('core.quotePath', 'false');

    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(quoted);
    expect(await workflowNames()).toBe(
      '.github/workflows/ci.yml\n.github/workflows/venfork-sync.yml'
    );
  });

  test('an allowlist removes a non-ASCII workflow it does not name', async () => {
    await fx.commitOnUpstream({
      '.github/workflows/exfïl.yml': 'x\n',
      '.github/workflows/ci.yml': 'ci\n',
    });
    await enableSchedule({ enabledWorkflows: ['ci.yml'] });

    await sync();

    expect(await workflowNames()).toBe(
      '.github/workflows/ci.yml\n.github/workflows/venfork-sync.yml'
    );
  });

  test('a blocked name with glob characters removes only that file', async () => {
    await fx.commitOnUpstream({
      '.github/workflows/[ab].yml': 'x\n',
      '.github/workflows/a.yml': 'keep me\n',
    });
    await enableSchedule({ disabledWorkflows: ['[ab].yml'] });

    await sync();

    expect(await workflowNames()).toBe(
      '.github/workflows/a.yml\n.github/workflows/venfork-sync.yml'
    );
  });
});

describe('preserved paths read from trees', () => {
  test('a dangling upstream symlink at a preserved path wins', async () => {
    await seedPreserve(fx, ['tools/cfg']);
    await fx.commitOnOrigin({ 'tools/cfg': 'mirror cfg\n' });
    await sync();
    await commitRawOnUpstream(async (dir) => {
      await mkdir(path.join(dir, 'tools'), { recursive: true });
      await symlink('../../outside/nowhere', path.join(dir, 'tools', 'cfg'));
    });

    await sync();

    expect(await fx.modeAt(fx.origin, 'main', 'tools/cfg')).toBe('120000');
    expect(await fx.sha(fx.origin, 'main')).toBe(
      await fx.sha(fx.upstream, 'main')
    );
  });

  test('a case-only clash keeps both the preserved and the upstream file', async () => {
    await seedPreserve(fx, ['docs/Notes.md']);
    await fx.commitOnOrigin({ 'docs/Notes.md': 'mirror notes\n' });
    await sync();
    await fx.commitOnUpstream({ 'docs/notes.md': 'upstream notes\n' });

    await sync();

    expect(await fx.fileAt(fx.origin, 'main', 'docs/Notes.md')).toBe(
      'mirror notes\n'
    );
    expect(await fx.fileAt(fx.origin, 'main', 'docs/notes.md')).toBe(
      'upstream notes\n'
    );
  });

  test('a non-ASCII preserved path is carried across sync', async () => {
    await seedPreserve(fx, ['docs/café.md']);
    await fx.commitOnOrigin({ 'docs/café.md': 'mirror\n' });

    await sync();
    await fx.commitOnUpstream({ 'src/later.txt': 'later\n' });
    await sync();

    expect(await fx.fileAt(fx.origin, 'main', 'docs/café.md')).toBe('mirror\n');
  });

  test('when upstream deletes a path it had taken over, sync restores the last upstream version', async () => {
    await seedPreserve(fx, ['docs/p.md']);
    await fx.commitOnOrigin({ 'docs/p.md': 'mirror p\n' });
    await sync();
    await fx.commitOnUpstream({ 'docs/p.md': 'upstream p\n' });
    await sync();
    await commitRawOnUpstream(async (dir) => {
      await $({ cwd: dir })`git rm --quiet docs/p.md`;
    }, 'chore: upstream deletes p');

    await sync();

    expect(await fx.fileAt(fx.origin, 'main', 'docs/p.md')).toBe(
      'upstream p\n'
    );
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { mirrorDenyList } from '../../src/shared/deny-list.js';

describe('mirrorDenyList', () => {
  const dirs: string[] = [];
  const saved = process.env.VENFORK_ALLOW_SELF_REFERENCE;

  afterEach(async () => {
    if (saved === undefined) delete process.env.VENFORK_ALLOW_SELF_REFERENCE;
    else process.env.VENFORK_ALLOW_SELF_REFERENCE = saved;
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  async function repoWith(origin: string, upstream: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'venfork-deny-'));
    dirs.push(dir);
    await $({ cwd: dir })`git init --quiet`;
    await $({ cwd: dir })`git remote add origin ${origin}`;
    await $({ cwd: dir })`git remote add upstream ${upstream}`;
    return dir;
  }

  test('adds the mirror repo name when it differs from upstream and is long enough', async () => {
    const dir = await repoWith(
      'git@github.com:acme/widget-private.git',
      'git@github.com:other/widget.git'
    );

    expect(await mirrorDenyList(dir)).toEqual([
      'git@github.com:acme/widget-private.git',
      'git@github.com:acme/widget-private',
      'acme/widget-private',
      'acme.github.io/widget-private',
      'widget-private',
      'venfork',
    ]);
  });

  test('reads owner/name from a non-github.com origin', async () => {
    const dir = await repoWith(
      'git@github.acme.com:team/widget-private.git',
      'git@github.com:other/widget.git'
    );

    expect(await mirrorDenyList(dir)).toEqual([
      'git@github.acme.com:team/widget-private.git',
      'git@github.acme.com:team/widget-private',
      'team/widget-private',
      'widget-private',
      'venfork',
    ]);
  });

  test('derives no owner/name from a local path origin', async () => {
    const dir = await repoWith(
      '/srv/git/widget-private.git',
      'git@github.com:other/widget.git'
    );

    expect(await mirrorDenyList(dir)).toEqual([
      '/srv/git/widget-private.git',
      '/srv/git/widget-private',
      'venfork',
    ]);
  });

  test.each([
    ['equals the upstream name', 'acme/widget-name', 'other/widget-name'],
    ['is shorter than six characters', 'acme/tiny', 'other/widget'],
  ])('leaves the mirror repo name out when it %s', async (_l, origin, up) => {
    const dir = await repoWith(
      `git@github.com:${origin}.git`,
      `git@github.com:${up}.git`
    );

    const terms = await mirrorDenyList(dir);

    expect(terms).not.toContain(origin.split('/')[1] ?? '');
  });

  test('VENFORK_ALLOW_SELF_REFERENCE drops only the bare word', async () => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
    const dir = await repoWith(
      'git@github.com:acme/widget-private.git',
      'git@github.com:other/widget.git'
    );

    const terms = await mirrorDenyList(dir);

    expect(terms).not.toContain('venfork');
    expect(terms).toContain('acme/widget-private');
    expect(terms).toContain('widget-private');
  });
});

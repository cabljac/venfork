import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { syncCommand } from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
import { ConfigError, SyncDivergenceError } from '../../src/errors.js';
import { getDefaultBranch } from '../../src/git.js';
import { checkDivergence } from '../../src/shared/divergence.js';
import { isManagedCommit } from '../../src/shared/managed-commit.js';
import { VENFORK_VERSION } from '../../src/version.js';
import { generateSyncWorkflow } from '../../src/workflow.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';
import { seedPreserve } from '../harness/preserve.js';

const MANAGED_SUBJECT = 'chore: venfork-managed mirror commit';
const CALLER = '.github/workflows/caller.yml';
const WORKFLOW = '.github/workflows/venfork-sync.yml';
const BOT = 'venfork-bot <venfork-bot@users.noreply.github.com>';

let fx: MirrorFixture;
let active: MirrorFixture | undefined;
const originalCwd = process.cwd();

beforeEach(async () => {
  fx = await createMirrorFixture();
  active = fx;
});

afterEach(async () => {
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
});

function sync(): Promise<void> {
  return syncCommand(undefined, { cwd: fx.work, quiet: true });
}

function enableSchedule(): Promise<unknown> {
  return updateVenforkConfig(fx.work, {
    schedule: { enabled: true, cron: '0 * * * *' },
  });
}

/** Waits until the wall clock enters the next whole second. */
async function nextSecond(): Promise<void> {
  const start = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === start) {
    await Bun.sleep(50);
  }
}

describe('harness', () => {
  test('getDefaultBranch resolves a local path remote', async () => {
    const trunk = await createMirrorFixture({ defaultBranch: 'trunk' });
    try {
      expect(await getDefaultBranch('upstream', trunk.work)).toBe('trunk');
    } finally {
      await trunk.cleanup();
    }
  });

  test('plain sync fast-forwards origin and public to upstream', async () => {
    const upstreamTip = await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });

    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(upstreamTip);
    expect(await fx.sha(fx.publicFork ?? '', 'main')).toBe(upstreamTip);
  });
});

describe('sync with the managed commit', () => {
  test('sync twice with no upstream change yields the same origin SHA', async () => {
    await enableSchedule();

    const firstAt = Math.floor(Date.now() / 1000);
    await sync();
    const first = await fx.sha(fx.origin, 'main');
    const pushesAfterFirst = await fx.pushCount(fx.origin, 'refs/heads/main');

    await nextSecond();
    const secondAt = Math.floor(Date.now() / 1000);
    await sync();

    expect(secondAt).toBeGreaterThan(firstAt);
    expect(await fx.sha(fx.origin, 'main')).toBe(first);
    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(
      pushesAfterFirst
    );
  });

  test('sync pushes origin exactly once', async () => {
    await enableSchedule();
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const before = await fx.pushCount(fx.origin, 'refs/heads/main');

    await sync();

    expect((await fx.pushCount(fx.origin, 'refs/heads/main')) - before).toBe(1);
    expect(await fx.subjects(fx.origin, 'main', 'main~1..main')).toEqual([
      MANAGED_SUBJECT,
    ]);
    expect(await fx.fileAt(fx.origin, 'main', WORKFLOW)).not.toBeNull();
  });

  test('managed commit carries Venfork-Managed trailer, bot identity and the upstream date', async () => {
    await enableSchedule();
    await sync();

    const format =
      '%(trailers:key=Venfork-Managed,valueonly)%x00%an <%ae>%x00%cn <%ce>%x00%cd';
    const [trailer, author, committer, date] = (
      await fx.git(
        fx.origin,
        'log',
        '-1',
        `--format=${format}`,
        '--date=raw',
        'main'
      )
    ).split('\0');
    const upstreamDate = await fx.git(
      fx.upstream,
      'log',
      '-1',
      '--format=%cd',
      '--date=raw',
      'main'
    );

    expect(trailer.trim()).toBe('1');
    expect(author).toBe(BOT);
    expect(committer).toBe(BOT);
    expect(date).toBe(upstreamDate);
  });

  test('sync replaces a legacy managed commit without reporting divergence', async () => {
    await enableSchedule();
    await fx.commitOnOrigin(
      { [WORKFLOW]: 'name: old venfork sync\n' },
      'chore: add/update scheduled sync workflow (venfork)'
    );

    await sync();

    expect(await fx.sha(fx.origin, 'main~1')).toBe(
      await fx.sha(fx.upstream, 'main')
    );
    expect(await fx.subjects(fx.origin, 'main', 'main~1..main')).toEqual([
      MANAGED_SUBJECT,
    ]);
    const migrated = await fx.sha(fx.origin, 'main');
    const pushes = await fx.pushCount(fx.origin, 'refs/heads/main');

    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(migrated);
    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(pushes);
  });

  test('sync replaces a current-subject managed commit that has no trailer, then stays stable', async () => {
    await enableSchedule();
    await fx.commitOnOrigin(
      { [WORKFLOW]: 'name: old managed commit\n' },
      MANAGED_SUBJECT
    );

    await sync();
    const migrated = await fx.sha(fx.origin, 'main');
    const pushes = await fx.pushCount(fx.origin, 'refs/heads/main');
    await sync();

    expect(await fx.sha(fx.origin, 'main~1')).toBe(
      await fx.sha(fx.upstream, 'main')
    );
    expect(await fx.sha(fx.origin, 'main')).toBe(migrated);
    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(pushes);
  });

  test('a trailer commit that only changes the sync workflow counts as managed whatever its subject', async () => {
    const sha = await fx.commitOnOrigin(
      { [WORKFLOW]: 'name: x\n' },
      'chore: something else\n\nVenfork-Managed: 1'
    );

    expect(await isManagedCommit(sha, fx.origin)).toBe(true);
    await sync();
    expect(await fx.sha(fx.origin, 'main')).toBe(
      await fx.sha(fx.upstream, 'main')
    );
  });

  test('the managed commit SHA ignores i18n.commitEncoding', async () => {
    await enableSchedule();
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'i18n.commitEncoding';
    process.env.GIT_CONFIG_VALUE_0 = 'ISO-8859-1';
    await sync();
    const latin1 = await fx.sha(fx.origin, 'main');
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;

    await fx.git(
      fx.work,
      'push',
      '--quiet',
      '--force',
      'origin',
      'upstream/main:refs/heads/main'
    );
    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(latin1);
  });

  test('sync with stale lease aborts rather than overwriting', async () => {
    await enableSchedule();
    await sync();
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const stale = `${fx.root}/stale-origin.git`;
    await fx.git(fx.root, 'clone', '--quiet', '--bare', fx.origin, stale);
    const teammate = await fx.commitOnOrigin({ 'src/team.txt': 'team\n' });
    await fx.git(fx.work, 'remote', 'set-url', 'origin', stale);
    await fx.git(fx.work, 'remote', 'set-url', '--push', 'origin', fx.origin);

    await expect(sync()).rejects.toThrow('process.exit(1)');

    expect(await fx.sha(fx.origin, 'main')).toBe(teammate);
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'origin/main moved since this sync fetched it. Re-run `venfork sync`'
      )
    );
  });

  test('sync does not touch public when public already equals upstream', async () => {
    await sync();
    const originPushes = await fx.pushCount(fx.origin, 'refs/heads/main');
    await enableSchedule();
    // Any push attempt to public now fails, like a missing cross-repo token.
    await fx.git(
      fx.work,
      'remote',
      'set-url',
      '--push',
      'public',
      `${fx.root}/missing.git`
    );

    await sync();

    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(
      originPushes + 1
    );
  });

  test('preserve-only with all files now upstream yields +0', async () => {
    process.chdir(fx.work);
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror version\n' });
    await sync();
    const upstreamTip = await fx.commitOnUpstream({
      [CALLER]: 'upstream version\n',
    });

    await sync();

    expect(await fx.sha(fx.origin, 'main')).toBe(upstreamTip);
  });

  test('sync throws SyncDivergenceError on a user commit to origin/main', async () => {
    await fx.commitOnOrigin({ 'src/hotfix.ts': 'export {};\n' });
    const originBefore = await fx.sha(fx.origin, 'main');

    const error = await sync().then(
      () => null,
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(SyncDivergenceError);
    const divergence = error as SyncDivergenceError;
    expect(divergence.origin).toEqual({ count: 1, files: ['src/hotfix.ts'] });
    expect(divergence.publicFork).toEqual({ count: 0, files: [] });
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });

  test('preserve carries a file across sync; upstream version wins when it appears upstream', async () => {
    process.chdir(fx.work);
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror version\n' });

    await fx.commitOnUpstream({ 'src/a.txt': 'a\n' });
    await sync();

    const upstreamTip = await fx.sha(fx.upstream, 'main');
    expect(await fx.subjects(fx.origin, 'main', 'main~1..main')).toEqual([
      MANAGED_SUBJECT,
    ]);
    expect(await fx.sha(fx.origin, 'main~1')).toBe(upstreamTip);
    expect(await fx.fileAt(fx.origin, 'main', CALLER)).toBe('mirror version\n');

    await fx.commitOnUpstream({ [CALLER]: 'upstream version\n' });
    await sync();

    expect(await fx.fileAt(fx.origin, 'main', CALLER)).toBe(
      'upstream version\n'
    );
  });

  test('preserve keeps the executable bit of a preserved script', async () => {
    process.chdir(fx.work);
    await seedPreserve(fx, ['scripts/release.sh']);
    await fx.commitOnOrigin({
      'scripts/release.sh': { content: '#!/bin/sh\n', executable: true },
    });

    await sync();

    expect(await fx.modeAt(fx.origin, 'main', 'scripts/release.sh')).toBe(
      '100755'
    );
  });

  test('a glob preserve entry aborts sync instead of reverting an upstream change', async () => {
    await updateVenforkConfig(fx.work, { preserve: ['src/file-*.txt'] });
    await fx.commitOnUpstream({ 'src/file-1.txt': 'upstream new\n' });
    const originBefore = await fx.sha(fx.origin, 'main');

    await expect(sync()).rejects.toBeInstanceOf(ConfigError);

    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });

  test('a pathspec-magic preserve entry aborts sync instead of rolling the tree back', async () => {
    await updateVenforkConfig(fx.work, { preserve: [':!nothing'] });
    await fx.commitOnUpstream({ 'src/added.txt': 'x\n' });
    const originBefore = await fx.sha(fx.origin, 'main');

    await expect(sync()).rejects.toBeInstanceOf(ConfigError);

    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });

  test('a preserved file whose parent becomes an upstream file fails and names both paths', async () => {
    process.chdir(fx.work);
    await seedPreserve(fx, ['config/x.yml']);
    await fx.commitOnOrigin({ 'config/x.yml': 'mirror\n' });
    await sync();
    const originBefore = await fx.sha(fx.origin, 'main');
    await fx.commitOnUpstream({ config: 'upstream file named config\n' });

    await expect(sync()).rejects.toThrow('process.exit(1)');

    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Preserved file 'config/x.yml' cannot be restored: upstream now has a file at 'config'"
      )
    );
  });

  test('a preserve entry that is a directory on the mirror is rejected', async () => {
    process.chdir(fx.work);
    await seedPreserve(fx, ['tools/a.sh', 'tools/b.sh']);
    await fx.commitOnOrigin({ 'tools/a.sh': 'a\n', 'tools/b.sh': 'b\n' });
    await sync();
    await updateVenforkConfig(fx.work, {
      preserve: ['tools', 'tools/a.sh', 'tools/b.sh'],
    });
    await fx.commitOnUpstream({ 'src/z.txt': 'z\n' });

    await expect(sync()).rejects.toThrow('process.exit(1)');

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Preserved path 'tools' is a directory on origin/main; preserve supports single files only"
      )
    );
  });
});

describe('divergence check errors', () => {
  test('an unresolvable upstream ref throws instead of reporting no divergence', async () => {
    await fx.commitOnOrigin({ 'src/mirror.txt': 'mirror\n' });
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(fx.work, 'update-ref', '-d', 'refs/remotes/upstream/main');
    const originBefore = await fx.sha(fx.origin, 'main');

    await expect(
      checkDivergence({
        remote: 'origin',
        defaultBranch: 'main',
        allowPreserved: true,
        preserveAllowed: new Set(),
        cwd: fx.work,
      })
    ).rejects.toThrow();
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });
});

describe('pinned version downgrade guard', () => {
  test('sync refuses to rewrite a workflow pinned to a newer venfork', async () => {
    await enableSchedule();
    await sync();
    await fx.commitOnOrigin(
      { [WORKFLOW]: generateSyncWorkflow('0 * * * *', 'standard', '99.0.0') },
      `${MANAGED_SUBJECT}\n\nVenfork-Managed: 1`
    );
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const originBefore = await fx.sha(fx.origin, 'main');

    await expect(sync()).rejects.toThrow('process.exit(1)');

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `origin pins venfork 99.0.0, you are running ${VENFORK_VERSION}`
      )
    );
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);
  });

  test('sync rewrites a workflow pinned to an older venfork', async () => {
    await enableSchedule();
    await sync();
    await fx.commitOnOrigin(
      { [WORKFLOW]: generateSyncWorkflow('0 * * * *', 'standard', '0.0.1') },
      `${MANAGED_SUBJECT}\n\nVenfork-Managed: 1`
    );

    await sync();

    expect(await fx.fileAt(fx.origin, 'main', WORKFLOW)).toBe(
      generateSyncWorkflow('0 * * * *', 'standard')
    );
  });
});

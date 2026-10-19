import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import {
  type DoctorCheck,
  type DoctorResult,
  doctorCommand,
  isHealthy,
  runDoctorChecks,
  syncCommand,
} from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
import { CommandExitError, UNMIGRATED_MIRROR_STEPS } from '../../src/errors.js';
import { VENFORK_VERSION } from '../../src/version.js';
import { generateSyncWorkflow } from '../../src/workflow.js';
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

function byId(checks: DoctorCheck[]): Record<string, DoctorCheck> {
  return Object.fromEntries(checks.map((check) => [check.id, check]));
}

async function scheduledAndSynced(): Promise<void> {
  await updateVenforkConfig(fx.work, {
    schedule: { enabled: true, cron: '0 */6 * * *' },
  });
  await syncCommand({ cwd: fx.work, quiet: true });
}

describe('doctor against real repos', () => {
  test('a freshly synced scheduled mirror passes every git check', async () => {
    await scheduledAndSynced();

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    for (const id of [
      'repo',
      'remotes',
      'mode',
      'invariant',
      'divergence',
      'preserve',
      'workflow',
    ]) {
      expect({ id, ok: checks[id]?.ok }).toEqual({ id, ok: true });
    }
    expect(checks.invariant.detail).toBe('upstream + 1 managed commit');
    for (const id of ['transport', 'token', 'last-run', 'cron-age']) {
      expect(checks[id]).toEqual({
        id,
        ok: 'skipped',
        detail: 'origin is not a GitHub repository',
      });
    }
  });

  test('returns every check and reports failure', async () => {
    await fx.commitOnOrigin({ 'src/hotfix.ts': 'export {};\n' });

    const result = await doctorCommand({ cwd: fx.work });

    expect(isHealthy(result)).toBe(false);
    expect(result.checks.map((check) => check.id)).toEqual([
      'repo',
      'remotes',
      'mode',
      'invariant',
      'divergence',
      'preserve',
      'workflow',
      'transport',
      'token',
      'last-run',
      'cron-age',
    ]);
    for (const check of result.checks) {
      expect([true, false, 'skipped']).toContain(check.ok);
      expect(typeof check.detail).toBe('string');
    }
  });

  test('prints the link maps after the checks and returns them', async () => {
    await updateVenforkConfig(fx.work, {
      shippedBranches: {
        'feat/x': {
          upstreamPrUrl: 'https://github.com/up/repo/pull/9',
          head: 'a'.repeat(40),
          shippedAt: '2025-03-04T10:00:00.000Z',
        },
      },
    });
    const notes: Array<[string, string]> = [];
    const noteSpy = spyOn(prompts, 'note').mockImplementation(
      (message?: string, title?: string) => {
        notes.push([title ?? '', message ?? '']);
      }
    );
    let result: DoctorResult;
    try {
      result = await doctorCommand({ cwd: fx.work });
    } finally {
      noteSpy.mockRestore();
    }

    const links = notes.find(([title]) => title === 'Links');
    expect(links?.[1]).toContain(
      'feat/x -> https://github.com/up/repo/pull/9 (2025-03-04)'
    );
    expect(notes[0][0]).toBe('Checks');
    expect(Object.keys(result.links?.shippedBranches ?? {})).toEqual([
      'feat/x',
    ]);
  });

  test('omits the Links note when no links are recorded', async () => {
    const notes: string[] = [];
    const noteSpy = spyOn(prompts, 'note').mockImplementation(
      (_message?: string, title?: string) => {
        notes.push(title ?? '');
      }
    );
    try {
      await doctorCommand({ cwd: fx.work });
    } finally {
      noteSpy.mockRestore();
    }
    expect(notes).not.toContain('Links');
  });

  test('flags a user commit on origin as divergence and a broken invariant', async () => {
    await fx.commitOnOrigin({ 'src/hotfix.ts': 'export {};\n' });

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.divergence.ok).toBe(false);
    expect(checks.divergence.detail).toContain('src/hotfix.ts');
    expect(checks.invariant.ok).toBe(false);
  });

  test('reports upstream commits that are not synced yet without failing', async () => {
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.invariant).toEqual({
      id: 'invariant',
      ok: true,
      detail: 'upstream (+0); 1 upstream commit(s) not synced yet',
    });
  });

  test('flags a preserved path that is missing on origin', async () => {
    await updateVenforkConfig(fx.work, { preserve: ['docs/MIRROR.md'] });

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.preserve.ok).toBe(false);
    expect(checks.preserve.detail).toContain('docs/MIRROR.md');
  });

  test('flags a missing and then a stale sync workflow', async () => {
    await updateVenforkConfig(fx.work, {
      schedule: { enabled: true, cron: '0 */6 * * *' },
    });

    let checks = byId(await runDoctorChecks({ cwd: fx.work }));
    expect(checks.workflow.ok).toBe(false);
    expect(checks.workflow.detail).toContain('missing');

    await syncCommand({ cwd: fx.work, quiet: true });
    await updateVenforkConfig(fx.work, {
      schedule: { enabled: true, cron: '0 * * * *' },
    });

    checks = byId(await runDoctorChecks({ cwd: fx.work }));
    expect(checks.workflow.ok).toBe(false);
    expect(checks.workflow.detail).toContain('stale');
    expect(checks.workflow.fix).toBe('Run `venfork sync`.');
  });

  test('flags an upstream remote whose push URL is not disabled', async () => {
    await fx.git(
      fx.work,
      'remote',
      'set-url',
      '--push',
      'upstream',
      fx.upstream
    );

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.remotes.ok).toBe(false);
    expect(checks.remotes.detail).toContain('expected DISABLE');
  });

  test('flags a public remote in a no-public mirror', async () => {
    const noPublic = await createMirrorFixture({ mode: 'no-public' });
    try {
      let checks = byId(await runDoctorChecks({ cwd: noPublic.work }));
      expect(checks.mode).toEqual({
        id: 'mode',
        ok: true,
        detail: 'own-upstream layout',
      });

      await noPublic.git(
        noPublic.work,
        'remote',
        'add',
        'public',
        noPublic.upstream
      );
      checks = byId(await runDoctorChecks({ cwd: noPublic.work }));
      expect(checks.mode.ok).toBe(false);
      expect(checks.mode.detail).toContain('a public remote exists');
    } finally {
      await noPublic.cleanup();
    }
  });

  test('reports a directory without venfork config and skips the rest', async () => {
    const checks = await runDoctorChecks({ cwd: fx.root });

    expect(checks[0].id).toBe('repo');
    expect(checks[0].ok).toBe(false);
    expect(checks.slice(1).every((check) => check.ok === 'skipped')).toBe(true);
  });
});

describe('doctor and a broken config', () => {
  test('an unparseable config is reported as invalid, not missing', async () => {
    await fx.writeRawConfig('{ not json');

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.repo.ok).toBe(false);
    expect(checks.repo.detail).toContain('not valid JSON');
    expect(checks.repo.detail).not.toContain('not found');
  });

  test('an unreachable origin is reported as a fetch failure', async () => {
    await fx.git(fx.work, 'remote', 'set-url', 'origin', `${fx.root}/gone.git`);

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.repo.ok).toBe(false);
    expect(checks.repo.detail).toStartWith('fetch failed: ');
  });

  test('a missing config branch has its own message', async () => {
    await fx.git(
      fx.work,
      'push',
      '--quiet',
      'origin',
      ':refs/heads/venfork-config'
    );

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.repo.ok).toBe(false);
    expect(checks.repo.detail).toContain('venfork-config branch not found');
  });

  test('the preserve check names invalid entries', async () => {
    const raw = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({ ...raw, preserve: ['docs/*.md'] })
    );

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.preserve.ok).toBe(false);
    expect(checks.preserve.detail).toContain('docs/*.md');
    expect(checks.preserve.fix).toContain("venfork keep remove 'docs/*.md'");
  });

  test('an invalid cron skips cron-age with the reason', async () => {
    const raw = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({ ...raw, schedule: { enabled: true, cron: '@hourly' } })
    );

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.repo.ok).toBe(false);
    expect(checks.repo.detail).toContain("schedule.cron '@hourly'");
    expect(checks['cron-age'].ok).toBe('skipped');
    expect(checks['cron-age'].detail).toContain(
      "schedule.cron '@hourly' is invalid"
    );
  });
});

describe('doctor and the pinned version', () => {
  test('names both versions when origin pins a newer venfork', async () => {
    await scheduledAndSynced();
    await fx.commitOnOrigin(
      {
        '.github/workflows/venfork-sync.yml': generateSyncWorkflow(
          '0 */6 * * *',
          'standard',
          '99.0.0'
        ),
      },
      'chore: venfork-managed mirror commit\n\nVenfork-Managed: 1'
    );

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.workflow.ok).toBe(false);
    expect(checks.workflow.detail).toContain(
      `origin pins venfork 99.0.0, newer than this CLI (${VENFORK_VERSION})`
    );
    expect(checks.workflow.fix).toContain('Upgrade venfork');
  });

  test('an unpinned workflow predates 0.11 and names the two migration steps', async () => {
    await scheduledAndSynced();
    await fx.commitOnOrigin(
      {
        '.github/workflows/venfork-sync.yml':
          'name: Venfork Sync\njobs:\n  sync:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install -g venfork\n      - run: venfork sync\n',
      },
      'chore: venfork-managed mirror commit\n\nVenfork-Managed: 1'
    );

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.workflow.ok).toBe(false);
    expect(checks.workflow.detail).toContain('predates venfork 0.11');
    expect(checks.workflow.detail).not.toContain('unknown');
    expect(checks.workflow.fix).toBe(UNMIGRATED_MIRROR_STEPS);
    expect(checks.workflow.fix).toContain('Set VENFORK_PUSH_TOKEN');
    expect(checks.workflow.fix).toContain('run `venfork sync` locally once');
  });
});

describe('doctor and the managed-commit invariant', () => {
  test('stacked managed commits ask for a sync to fold them, and sync clears it', async () => {
    await scheduledAndSynced();
    await fx.commitOnOrigin(
      { '.github/workflows/venfork-sync.yml': 'stacked\n' },
      'chore: venfork-managed mirror commit\n\nVenfork-Managed: 1'
    );

    let checks = byId(await runDoctorChecks({ cwd: fx.work }));
    expect(checks.divergence.ok).toBe(true);
    expect(checks.invariant).toEqual({
      id: 'invariant',
      ok: false,
      detail:
        'origin/main has 2 venfork-managed or preserve-only commits above upstream instead of one',
      fix: 'Run `venfork sync` to fold the 2 commits into one managed commit.',
    });

    await syncCommand({ cwd: fx.work, quiet: true });

    checks = byId(await runDoctorChecks({ cwd: fx.work }));
    expect(checks.invariant).toEqual({
      id: 'invariant',
      ok: true,
      detail: 'upstream + 1 managed commit',
    });
  });

  test('a hand-edited sync workflow by a non-bot author is divergence', async () => {
    await scheduledAndSynced();
    await fx.commitOnOrigin(
      { '.github/workflows/venfork-sync.yml': 'name: hand edited\n' },
      'ci: tweak the sync workflow'
    );

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.divergence.ok).toBe(false);
    expect(checks.divergence.detail).toContain(
      '.github/workflows/venfork-sync.yml'
    );
    expect(checks.invariant).toEqual({
      id: 'invariant',
      ok: false,
      detail:
        'origin/main is not an upstream commit plus at most one venfork-managed commit',
      fix: 'Resolve the divergence below, then run `venfork sync`.',
    });
  });
});

describe('doctor and broken remotes', () => {
  test('a missing upstream remote gets the exact add command and skips its dependents', async () => {
    await fx.git(fx.work, 'remote', 'remove', 'upstream');
    const config = await fx.readRawConfig();

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.remotes.ok).toBe(false);
    expect(checks.remotes.detail).toBe('upstream missing');
    expect(checks.remotes.fix).toBe(
      `git remote add upstream ${config.upstreamUrl} && git remote set-url --push upstream DISABLE`
    );
    for (const id of ['invariant', 'divergence', 'preserve', 'workflow']) {
      expect(checks[id]).toEqual({
        id,
        ok: 'skipped',
        detail: 'needs the origin and upstream remotes',
      });
    }
  });

  test('a fetch failure is one remotes row and skips its dependents', async () => {
    await rename(fx.upstream, `${fx.upstream}.gone`);
    let checks: Record<string, DoctorCheck>;
    try {
      checks = byId(await runDoctorChecks({ cwd: fx.work }));
    } finally {
      await rename(`${fx.upstream}.gone`, fx.upstream);
    }

    expect(checks.remotes.ok).toBe(false);
    expect(checks.remotes.detail).toStartWith('git fetch failed: ');
    expect(checks.remotes.detail).not.toContain('\n');
    for (const id of ['invariant', 'divergence', 'preserve', 'workflow']) {
      expect(checks[id]).toEqual({
        id,
        ok: 'skipped',
        detail: 'needs a successful git fetch',
      });
    }
  });

  test('a missing config branch and a non-repo have different fixes', async () => {
    const notRepo = byId(await runDoctorChecks({ cwd: fx.root }));
    await fx.git(
      fx.work,
      'push',
      '--quiet',
      'origin',
      ':refs/heads/venfork-config'
    );
    const noConfig = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(notRepo.repo.fix).toBe(
      'Run from a clone made by `venfork setup` or `venfork clone`.'
    );
    expect(noConfig.repo.fix).toContain('venfork setup');
    expect(noConfig.repo.fix).not.toBe(notRepo.repo.fix);
  });
});

describe('the preserve check asks the tip builder sync uses', () => {
  async function preservedAndSynced(entry: string): Promise<void> {
    await seedPreserve(fx, [entry]);
    await fx.commitOnOrigin({ [entry]: 'mirror\n' });
    await syncCommand({ cwd: fx.work, quiet: true });
  }

  test('a directory entry fails as it does in sync', async () => {
    await fx.commitOnUpstream({ 'docs/a.md': 'a\n' });
    await syncCommand({ cwd: fx.work, quiet: true });
    await seedPreserve(fx, ['docs']);

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.preserve.ok).toBe(false);
    expect(checks.preserve.detail).toContain("venfork keep remove 'docs'");
  });

  test('an upstream directory at a preserved path fails as it does in sync', async () => {
    await preservedAndSynced('MIRROR.md');
    await fx.commitOnUpstream({ 'MIRROR.md/inner.md': 'x\n' });

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.preserve.ok).toBe(false);
    expect(checks.preserve.detail).toContain('directory');
    expect(checks.preserve.fix).toContain("venfork keep remove 'MIRROR.md'");
    await expect(syncCommand({ cwd: fx.work, quiet: true })).rejects.toThrow(
      new CommandExitError(1)
    );
  });

  test('an upstream file at an ancestor of a preserved path fails as it does in sync', async () => {
    await preservedAndSynced('ci/local.yml');
    await fx.commitOnUpstream({ ci: 'file\n' });

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.preserve.ok).toBe(false);
    expect(checks.preserve.detail).toContain("file at 'ci'");
  });

  test('a preserved path missing on origin but present upstream passes, as sync does', async () => {
    await seedPreserve(fx, ['docs/X.md']);
    await fx.commitOnUpstream({ 'docs/X.md': 'upstream\n' });

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));

    expect(checks.preserve.ok).toBe(true);
    await expect(
      syncCommand({ cwd: fx.work, quiet: true })
    ).resolves.toMatchObject({ kind: 'default-branch' });
  });
});

describe('doctor and GitHub App auth', () => {
  const schedule = { enabled: true, cron: '0 */6 * * *' };
  const syncAt = (cwd: string) => syncCommand({ cwd, quiet: true });

  test('a no-public mirror gets the mint step and an up-to-date workflow check', async () => {
    const noPublic = await createMirrorFixture({ mode: 'no-public' });
    try {
      await updateVenforkConfig(noPublic.work, {
        schedule,
        scheduleAuth: 'app',
      });
      await syncAt(noPublic.work);

      const workflow = await noPublic.fileAt(
        noPublic.origin,
        'main',
        '.github/workflows/venfork-sync.yml'
      );
      expect(workflow).toBe(
        generateSyncWorkflow(schedule.cron, 'no-public', VENFORK_VERSION, {
          kind: 'app',
        })
      );
      const checks = byId(await runDoctorChecks({ cwd: noPublic.work }));
      expect(checks.workflow).toEqual({
        id: 'workflow',
        ok: true,
        detail: expect.any(String),
      });
    } finally {
      await noPublic.cleanup();
    }
  });

  test('a standard mirror scopes the token to the public fork named in config', async () => {
    const config = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({
        ...config,
        publicForkUrl: 'git@github.com:acme/project.git',
        schedule,
        scheduleAuth: 'app',
      })
    );
    await syncAt(fx.work);

    expect(
      await fx.fileAt(fx.origin, 'main', '.github/workflows/venfork-sync.yml')
    ).toBe(
      generateSyncWorkflow(schedule.cron, 'standard', VENFORK_VERSION, {
        kind: 'app',
        publicRepo: { owner: 'acme', name: 'project' },
      })
    );
    const checks = byId(await runDoctorChecks({ cwd: fx.work }));
    expect(checks.workflow.ok).toBe(true);
  });

  test('a public fork that is not on GitHub stops sync and fails the workflow check', async () => {
    await updateVenforkConfig(fx.work, { schedule, scheduleAuth: 'app' });
    const originBefore = await fx.sha(fx.origin, 'main');

    await expect(syncAt(fx.work)).rejects.toThrow(
      'GitHub App auth needs the public fork on GitHub'
    );
    expect(await fx.sha(fx.origin, 'main')).toBe(originBefore);

    const checks = byId(await runDoctorChecks({ cwd: fx.work }));
    expect(checks.workflow.ok).toBe(false);
    expect(checks.workflow.detail).toContain(
      'GitHub App auth needs the public fork on GitHub'
    );
    expect(checks.workflow.fix).toBe(
      'Run `venfork schedule set "0 */6 * * *" --token`.'
    );
  });
});

describe('doctor transport check against a real ssh command', () => {
  test('a quoted GIT_SSH_COMMAND with a space in its path reaches origin', async () => {
    const sshDir = path.join(fx.root, 'ssh tools');
    await mkdir(sshDir);
    const fakeSsh = path.join(sshDir, 'fake ssh');
    await writeFile(
      fakeSsh,
      `#!/bin/sh\nexec git-upload-pack ${JSON.stringify(fx.origin)}\n`
    );
    await chmod(fakeSsh, 0o755);
    await fx.git(
      fx.work,
      'remote',
      'set-url',
      '--push',
      'origin',
      'git@github.com:acme/widget-private.git'
    );
    const saved = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = `"${fakeSsh}" -o IdentitiesOnly=yes`;
    try {
      const checks = byId(await runDoctorChecks({ cwd: fx.work }));

      expect(checks.transport).toEqual({
        id: 'transport',
        ok: true,
        detail: 'origin uses ssh; git reaches it',
      });
    } finally {
      if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = saved;
    }
  });
});

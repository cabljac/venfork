import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rename } from 'node:fs/promises';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import {
  type DoctorCheck,
  doctorCommand,
  runDoctorChecks,
  syncCommand,
} from '../../src/commands.js';
import { updateVenforkConfig } from '../../src/config.js';
import { VENFORK_VERSION } from '../../src/version.js';
import { generateSyncWorkflow } from '../../src/workflow.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

let fx: MirrorFixture;

beforeEach(async () => {
  fx = await createMirrorFixture();
});

afterEach(async () => {
  await fx.cleanup();
});

function byId(checks: DoctorCheck[]): Record<string, DoctorCheck> {
  return Object.fromEntries(checks.map((check) => [check.id, check]));
}

async function scheduledAndSynced(): Promise<void> {
  await updateVenforkConfig(fx.work, {
    schedule: { enabled: true, cron: '0 */6 * * *' },
  });
  await syncCommand(undefined, { cwd: fx.work, quiet: true });
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
    for (const id of ['token', 'last-run', 'cron-age']) {
      expect(checks[id]).toEqual({
        id,
        ok: 'skipped',
        detail: 'origin is not a GitHub repository',
      });
    }
  });

  test('--json prints every check and reports failure', async () => {
    await fx.commitOnOrigin({ 'src/hotfix.ts': 'export {};\n' });
    const printed: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => {
      printed.push(line);
    };
    let healthy: boolean;
    try {
      healthy = await doctorCommand({ json: true, cwd: fx.work });
    } finally {
      console.log = originalLog;
    }

    expect(healthy).toBe(false);
    const parsed = JSON.parse(printed.join('\n')) as DoctorCheck[];
    expect(parsed.map((check) => check.id)).toEqual([
      'repo',
      'remotes',
      'mode',
      'invariant',
      'divergence',
      'preserve',
      'workflow',
      'token',
      'last-run',
      'cron-age',
    ]);
    for (const check of parsed) {
      expect([true, false, 'skipped']).toContain(check.ok);
      expect(typeof check.detail).toBe('string');
    }
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

    await syncCommand(undefined, { cwd: fx.work, quiet: true });
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
        detail: 'no-public layout',
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
    expect(checks.preserve.fix).toContain('venfork preserve remove docs/*.md');
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
});

describe('doctor and the managed-commit invariant', () => {
  test('stacked managed commits ask for a sync to fold them, and sync clears it', async () => {
    await scheduledAndSynced();
    await fx.commitOnOrigin(
      { 'docs/extra.md': 'stacked\n' },
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

    await syncCommand(undefined, { cwd: fx.work, quiet: true });

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

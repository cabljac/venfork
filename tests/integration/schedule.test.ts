import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { scheduleCommand, syncCommand } from '../../src/commands.js';
import { readVenforkConfigFromRepo } from '../../src/config.js';
import { VENFORK_VERSION } from '../../src/version.js';
import {
  generateSyncWorkflow,
  getSyncWorkflowPath,
} from '../../src/workflow.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

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

describe('schedule against real repos', () => {
  test('set writes the workflow as a managed commit; disable removes it', async () => {
    const workflowPath = getSyncWorkflowPath();
    const upstreamTip = await fx.sha(fx.upstream, 'main');

    await scheduleCommand('set', '0 */6 * * *');

    expect((await readVenforkConfigFromRepo(fx.work))?.schedule).toEqual({
      enabled: true,
      cron: '0 */6 * * *',
    });
    expect(await fx.fileAt(fx.origin, 'main', workflowPath)).toBe(
      generateSyncWorkflow('0 */6 * * *', 'standard')
    );
    expect(await fx.sha(fx.origin, 'main~1')).toBe(upstreamTip);

    await scheduleCommand('disable');

    expect(await fx.fileAt(fx.origin, 'main', workflowPath)).toBeNull();
  });

  test('set leaves exactly one managed commit that a following sync keeps as is', async () => {
    await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });
    const upstreamTip = await fx.sha(fx.upstream, 'main');

    await scheduleCommand('set', '0 */6 * * *');

    expect(await fx.sha(fx.origin, 'main~1')).toBe(upstreamTip);
    expect(await fx.subjects(fx.origin, 'main', 'main~1..main')).toEqual([
      'chore: venfork-managed mirror commit',
    ]);
    const tip = await fx.sha(fx.origin, 'main');
    const pushes = await fx.pushCount(fx.origin, 'refs/heads/main');

    await syncCommand(undefined, { cwd: fx.work, quiet: true });

    expect(await fx.sha(fx.origin, 'main')).toBe(tip);
    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(pushes);
  });

  test('disable returns origin to the plain upstream tip', async () => {
    await scheduleCommand('set', '0 */6 * * *');

    await scheduleCommand('disable');

    expect(await fx.sha(fx.origin, 'main')).toBe(
      await fx.sha(fx.upstream, 'main')
    );
  });
});

describe('schedule with GitHub App auth', () => {
  const cron = '0 */6 * * *';
  const workflowPath = getSyncWorkflowPath();
  const appWorkflow = () =>
    generateSyncWorkflow(cron, 'standard', VENFORK_VERSION, {
      kind: 'app',
      publicRepo: { owner: 'acme', name: 'project' },
    });

  async function usePublicForkOnGitHub(): Promise<void> {
    const config = await fx.readRawConfig();
    await fx.writeRawConfig(
      JSON.stringify({
        ...config,
        publicForkUrl: 'git@github.com:acme/project.git',
      })
    );
  }

  test('set --app writes one managed commit with the mint step that a sync keeps', async () => {
    await usePublicForkOnGitHub();
    const upstreamTip = await fx.sha(fx.upstream, 'main');

    await scheduleCommand('set', cron, { auth: 'app' });

    expect((await readVenforkConfigFromRepo(fx.work))?.scheduleAuth).toBe(
      'app'
    );
    expect(await fx.fileAt(fx.origin, 'main', workflowPath)).toBe(
      appWorkflow()
    );
    expect(await fx.sha(fx.origin, 'main~1')).toBe(upstreamTip);
    const tip = await fx.sha(fx.origin, 'main');
    const pushes = await fx.pushCount(fx.origin, 'refs/heads/main');

    await syncCommand(undefined, { cwd: fx.work, quiet: true });

    expect(await fx.sha(fx.origin, 'main')).toBe(tip);
    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(pushes);
  });

  test('switching token to app to token rebuilds the managed commit and returns to the same SHA', async () => {
    await usePublicForkOnGitHub();
    const upstreamTip = await fx.sha(fx.upstream, 'main');

    await scheduleCommand('set', cron);
    const tokenTip = await fx.sha(fx.origin, 'main');

    await scheduleCommand('set', cron, { auth: 'app' });
    const appTip = await fx.sha(fx.origin, 'main');
    expect(appTip).not.toBe(tokenTip);
    expect(await fx.sha(fx.origin, 'main~1')).toBe(upstreamTip);
    expect(await fx.fileAt(fx.origin, 'main', workflowPath)).toBe(
      appWorkflow()
    );

    await scheduleCommand('set', cron, { auth: 'token' });
    expect(await fx.sha(fx.origin, 'main')).toBe(tokenTip);
    expect(await readVenforkConfigFromRepo(fx.work)).not.toHaveProperty(
      'scheduleAuth'
    );

    await syncCommand(undefined, { cwd: fx.work, quiet: true });
    expect(await fx.sha(fx.origin, 'main')).toBe(tokenTip);
  });

  test('set without a flag keeps app auth, and so do disable and a later set', async () => {
    await usePublicForkOnGitHub();
    await scheduleCommand('set', cron, { auth: 'app' });

    await scheduleCommand('set', '30 2 * * *');
    expect((await readVenforkConfigFromRepo(fx.work))?.scheduleAuth).toBe(
      'app'
    );

    await scheduleCommand('disable');
    expect(await fx.fileAt(fx.origin, 'main', workflowPath)).toBeNull();
    expect((await readVenforkConfigFromRepo(fx.work))?.scheduleAuth).toBe(
      'app'
    );

    await scheduleCommand('set', cron);
    expect(await fx.fileAt(fx.origin, 'main', workflowPath)).toBe(
      appWorkflow()
    );
  });

  test('set --app refuses a public fork under another owner and writes nothing', async () => {
    await usePublicForkOnGitHub();
    const mirrorUrl = 'git@github.com:other/project-private.git';
    await fx.git(fx.work, 'config', `url.${fx.origin}.insteadOf`, mirrorUrl);
    await fx.git(fx.work, 'remote', 'set-url', 'origin', mirrorUrl);
    const configBefore = await fx.sha(fx.origin, 'venfork-config');
    const mainBefore = await fx.sha(fx.origin, 'main');

    await expect(scheduleCommand('set', cron, { auth: 'app' })).rejects.toThrow(
      'process.exit(1)'
    );

    expect(
      String(
        (prompts.log.error as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]
      )
    ).toContain(
      'the mirror is other/project-private and the public fork is acme/project'
    );
    expect(await fx.sha(fx.origin, 'venfork-config')).toBe(configBefore);
    expect(await fx.sha(fx.origin, 'main')).toBe(mainBefore);
  });

  test('status shows the auth mode', async () => {
    await usePublicForkOnGitHub();
    await scheduleCommand('set', cron, { auth: 'app' });

    await scheduleCommand('status');

    expect(
      String((prompts.note as ReturnType<typeof mock>).mock.calls.at(-1)?.[0])
    ).toContain(
      'Auth: GitHub App (secrets VENFORK_APP_CLIENT_ID, VENFORK_APP_PRIVATE_KEY)'
    );
  });
});

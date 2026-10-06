import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { scheduleCommand, syncCommand } from '../../src/commands.js';
import { readVenforkConfigFromRepo } from '../../src/config.js';
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

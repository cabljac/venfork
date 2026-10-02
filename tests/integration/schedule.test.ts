import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { scheduleCommand } from '../../src/commands.js';
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
const originalCwd = process.cwd();

beforeEach(async () => {
  fx = await createMirrorFixture();
  process.chdir(fx.work);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fx.cleanup();
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
});

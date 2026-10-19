import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import {
  type ApprovalScenario,
  approvalRoutes,
  type GhMirror,
  githubMirror,
  MIRROR_REPO,
} from '../harness/gh-mirror.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

let fx: MirrorFixture;
let gh: GhMirror;
const originalCwd = process.cwd();

beforeEach(async () => {
  fx = await createMirrorFixture();
  process.chdir(fx.work);
  gh = await githubMirror(fx);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fx.cleanup();
});

const NO_TERMINAL = { yes: true, noInput: true };
const AT_TERMINAL = { yes: true, noInput: false };
const COMMENT = `--method POST repos/${MIRROR_REPO}/issues/7/comments`;

async function setApproval(level: string | undefined): Promise<void> {
  const config = await fx.readRawConfig();
  if (level === undefined) delete config.approval;
  else config.approval = level;
  await fx.writeRawConfig(JSON.stringify(config, null, 2));
}

async function pushFeature(): Promise<string> {
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature', 'origin/main');
  await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
  await fx.git(fx.work, 'add', 'src/feature.txt');
  await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: feature work');
  await fx.git(fx.work, 'push', '--quiet', 'origin', 'feature');
  return fx.sha(fx.work, 'feature');
}

async function refusedScenario(
  head: string,
  extra: Partial<ApprovalScenario> = {},
  comment = { exitCode: 0 }
): Promise<void> {
  await gh.setRoutes([
    { match: COMMENT, stdout: '{}', exitCode: comment.exitCode },
    ...approvalRoutes({
      branch: 'feature',
      headSha: head,
      stager: 'solo',
      reviews: [{ login: 'solo', state: 'APPROVED' }],
      ...extra,
    }),
  ]);
}

const publicHasFeature = async () =>
  (await fx.git(fx.publicFork ?? '', 'branch', '--list', 'feature')) !== '';

const errorText = () =>
  (prompts.log.error as ReturnType<typeof mock>).mock.calls
    .map((c) => String(c[0]))
    .join('\n');

describe('stage --force past the approval gate', () => {
  test('a confirmed bypass is recorded on the mirror PR only, and nothing about it is published', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await refusedScenario(head);

    const result = await stageCommand('feature', {
      force: true,
      prompt: AT_TERMINAL,
    });

    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'Bypass the approval gate (two-person)'
        ),
      })
    );
    expect(result).toMatchObject({
      approval: { bypassed: true, reason: 'self-approved', headSha: head },
    });
    const calls = await gh.calls();
    const writes = calls.filter((call) => call.includes('--method'));
    expect(writes).toEqual([`api ${COMMENT} --input -`]);
    expect(
      calls.every((call) => call.includes(MIRROR_REPO) || call === 'api user')
    ).toBe(true);
    const [input = '{}'] = await gh.inputs();
    const body = JSON.parse(input).body as string;
    expect(body).toContain('bypassed with `venfork stage --force` by @solo');
    expect(body).toContain(head);

    expect(await publicHasFeature()).toBe(true);
    const published = await fx.git(
      fx.publicFork ?? '',
      'log',
      '--format=%B%an%ae%cn%ce',
      'main..feature'
    );
    expect(published).toBe(
      await fx.git(
        fx.work,
        'log',
        '--format=%B%an%ae%cn%ce',
        'origin/main..feature'
      )
    );
    expect(published).not.toMatch(/bypass|force|approv|solo/i);
    const config = await fx.readRawConfig();
    expect(JSON.stringify(config)).not.toMatch(/bypass|forced|approvedBy/i);
  });

  test('--force --yes cannot answer the bypass confirm without a terminal', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await refusedScenario(head);

    await expect(
      stageCommand('feature', { force: true, prompt: NO_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorText()).toContain(
      '--force needs a person to confirm the bypass'
    );
    expect((await gh.calls()).some((c) => c.includes('--method'))).toBe(false);
    expect(await publicHasFeature()).toBe(false);
  });

  test('answering no stages nothing and posts nothing', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await refusedScenario(head, { reviews: [] });
    (prompts.confirm as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.resolve(false)
    );

    await expect(
      stageCommand('feature', { force: true, prompt: AT_TERMINAL })
    ).rejects.toThrow(new CommandExitError(0));

    expect((await gh.calls()).some((c) => c.includes('--method'))).toBe(false);
    expect(await publicHasFeature()).toBe(false);
  });

  test('a comment that cannot be posted pushes nothing', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await refusedScenario(head, {}, { exitCode: 1 });

    await expect(
      stageCommand('feature', { force: true, prompt: AT_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorText()).toContain('could not record the --force bypass');
    expect(await publicHasFeature()).toBe(false);
  });

  test('a branch with no open mirror PR cannot be forced', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await refusedScenario(head, { noPr: true });

    await expect(
      stageCommand('feature', { force: true, prompt: AT_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorText()).toContain(
      '--force records the bypass on the mirror PR'
    );
    expect(await publicHasFeature()).toBe(false);
  });

  test('a branch moved during the bypass confirm ships the confirmed commit, and the comment names it', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await refusedScenario(head);
    (prompts.confirm as ReturnType<typeof mock>).mockImplementationOnce(
      async () => {
        await Bun.write(`${fx.work}/src/sneak.txt`, 'sneak\n');
        await fx.git(fx.work, 'add', 'src/sneak.txt');
        await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: sneaked in');
        return true;
      }
    );

    await stageCommand('feature', { force: true, prompt: AT_TERMINAL });

    const [input = '{}'] = await gh.inputs();
    expect(JSON.parse(input).body).toContain(head);
    const published = await fx.git(
      fx.publicFork ?? '',
      'log',
      '--format=%s',
      'main..feature'
    );
    expect(published).toBe('feat: feature work');
  });

  test('--force does not bypass a local branch that differs from the mirror PR head', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await refusedScenario(head);
    await Bun.write(`${fx.work}/src/unpushed.txt`, 'unpushed\n');
    await fx.git(fx.work, 'add', 'src/unpushed.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: not on the PR');

    await expect(
      stageCommand('feature', { force: true, prompt: AT_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorText()).toContain(
      `but the approved PR head is ${head.slice(0, 12)}`
    );
    expect(errorText()).not.toContain('--force records the bypass');
    expect((await gh.calls()).some((c) => c.includes('--method'))).toBe(false);
    expect(await publicHasFeature()).toBe(false);
  });

  test('a bypass that cannot find the mirror to record on pushes nothing', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await refusedScenario(head);
    (prompts.confirm as ReturnType<typeof mock>).mockImplementationOnce(
      async () => {
        await fx.git(fx.work, 'remote', 'set-url', 'origin', fx.origin);
        return true;
      }
    );

    await expect(
      stageCommand('feature', { force: true, prompt: AT_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorText()).toContain('could not record the --force bypass');
    expect((await gh.calls()).some((c) => c.includes('--method'))).toBe(false);
    expect(await publicHasFeature()).toBe(false);
  });

  test('with approval off, --force changes nothing and says so', async () => {
    await pushFeature();

    await stageCommand('feature', { force: true, prompt: NO_TERMINAL });

    expect(prompts.log.warn).toHaveBeenCalledWith(
      'approval is off, so --force has nothing to bypass.',
      expect.anything()
    );
    expect(await gh.calls()).toEqual([]);
    expect(await publicHasFeature()).toBe(true);
  });
});

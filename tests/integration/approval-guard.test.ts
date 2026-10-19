import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as prompts from '@clack/prompts';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import {
  approvalMemoryPath,
  rememberApproval,
} from '../../src/shared/approval-guard.js';
import {
  approvalRoutes,
  type GhMirror,
  githubMirror,
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
  (prompts.confirm as ReturnType<typeof mock>).mockClear();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fx.cleanup();
});

/** `--yes` where venfork cannot prompt, as a script or agent runs it. */
const NO_TERMINAL = { yes: true, noInput: true };
/** `--yes` at a terminal: the preload pins stdin and stderr as TTYs. */
const AT_TERMINAL = { yes: true, noInput: false };

async function writeConfig(patch: Record<string, unknown>): Promise<void> {
  const config = { ...(await fx.readRawConfig()), ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete config[key];
  }
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

const memoryFile = () => approvalMemoryPath(fx.work);

const readMemory = async () =>
  JSON.parse(await readFile(await memoryFile(), 'utf8'));

const publicHasFeature = async () =>
  (await fx.git(fx.publicFork ?? '', 'branch', '--list', 'feature')) !== '';

const errorText = () =>
  (prompts.log.error as ReturnType<typeof mock>).mock.calls
    .map((c) => String(c[0]))
    .join('\n');

const loweredConfirm = () =>
  (prompts.confirm as ReturnType<typeof mock>).mock.calls.filter((c) =>
    String((c[0] as { message?: string }).message).includes(
      'The approval gate was lowered'
    )
  );

async function approveFeature(head: string): Promise<void> {
  await gh.setRoutes(
    approvalRoutes({
      branch: 'feature',
      headSha: head,
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    })
  );
}

describe('the clone memory of the last approval level', () => {
  test('a fresh clone records the level without a confirm, and does not know an earlier level', async () => {
    await pushFeature();
    await writeConfig({ approval: 'two-person' });
    await writeConfig({ approval: undefined });

    await stageCommand('feature', { prompt: NO_TERMINAL });

    expect(await publicHasFeature()).toBe(true);
    expect(loweredConfirm()).toHaveLength(0);
    expect(await readFile(await memoryFile(), 'utf8')).toBe(
      '{\n  "level": "off"\n}\n'
    );
  });

  test('a level lower than the memory refuses a --yes stage that cannot prompt', async () => {
    const head = await pushFeature();
    await writeConfig({ approval: 'reviewed' });
    await approveFeature(head);
    await stageCommand('feature', { prompt: NO_TERMINAL });
    await fx.git(fx.publicFork ?? '', 'branch', '-D', 'feature');
    await writeConfig({ approval: undefined });

    await expect(
      stageCommand('feature', { prompt: NO_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorText()).toContain('this clone last saw reviewed');
    expect(errorText()).toContain('--yes does not answer it');
    expect(await publicHasFeature()).toBe(false);
    expect((await readMemory()).level).toBe('reviewed');
  });

  test('at a terminal a person confirms once, even with --yes; the clone then remembers the new level', async () => {
    await pushFeature();
    await rememberApproval(fx.work, 'reviewed');

    await stageCommand('feature', { prompt: AT_TERMINAL });

    expect(loweredConfirm()).toHaveLength(1);
    expect(await publicHasFeature()).toBe(true);
    expect((await readMemory()).level).toBe('off');

    await stageCommand('feature', { prompt: NO_TERMINAL });
  });

  test('answering no at the terminal stages nothing and keeps the memory', async () => {
    const head = await pushFeature();
    await rememberApproval(fx.work, 'two-person');
    await writeConfig({ approval: 'reviewed' });
    await approveFeature(head);
    (prompts.confirm as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.resolve(false)
    );

    await expect(
      stageCommand('feature', { prompt: AT_TERMINAL })
    ).rejects.toThrow(new CommandExitError(0));
    expect(await publicHasFeature()).toBe(false);
    expect((await readMemory()).level).toBe('two-person');
  });

  test('a lowering that was raised back before the stage is not flagged', async () => {
    const head = await pushFeature();
    await rememberApproval(fx.work, 'reviewed');
    await writeConfig({ approval: undefined });
    await writeConfig({ approval: 'reviewed' });
    await approveFeature(head);

    await stageCommand('feature', { prompt: NO_TERMINAL });

    expect(await publicHasFeature()).toBe(true);
  });

  test('a higher level is recorded without a confirm', async () => {
    const head = await pushFeature();
    await rememberApproval(fx.work, 'off');
    await writeConfig({ approval: 'reviewed' });
    await approveFeature(head);

    await stageCommand('feature', { prompt: NO_TERMINAL });

    expect(loweredConfirm()).toHaveLength(0);
    expect((await readMemory()).level).toBe('reviewed');
  });

  test('--dry-run reports the lowered level and writes no memory', async () => {
    await pushFeature();
    await rememberApproval(fx.work, 'two-person');

    const result = await stageCommand('feature', { dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      weakened: { from: 'two-person', to: 'off' },
    });
    expect((await readMemory()).level).toBe('two-person');
  });
});

describe('a clone memory that cannot be read counts as two-person', () => {
  test('a corrupt memory refuses a lowered stage and says so', async () => {
    await pushFeature();
    await rememberApproval(fx.work, 'reviewed');
    await writeFile(await memoryFile(), '{not json');

    await expect(
      stageCommand('feature', { prompt: NO_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));
    expect(errorText()).toContain('treats it as two-person');
    expect(await publicHasFeature()).toBe(false);
  });

  test('an unreadable memory refuses a lowered stage and says so', async () => {
    const head = await pushFeature();
    const file = await memoryFile();
    await mkdir(file, { recursive: true });
    await writeConfig({ approval: 'reviewed' });
    await approveFeature(head);

    await expect(
      stageCommand('feature', { prompt: NO_TERMINAL })
    ).rejects.toThrow(new CommandExitError(1));
    expect(errorText()).toContain('treats it as two-person');
    await rm(file, { recursive: true });
  });

  test('a corrupt memory at two-person is replaced without a confirm', async () => {
    const head = await pushFeature();
    await rememberApproval(fx.work, 'two-person');
    await writeFile(await memoryFile(), '{"level": 3}');
    await writeConfig({ approval: 'two-person' });
    await gh.setRoutes(
      approvalRoutes({
        branch: 'feature',
        headSha: head,
        reviews: [
          { login: 'alice', state: 'APPROVED' },
          { login: 'bob', state: 'APPROVED' },
        ],
      })
    );

    await stageCommand('feature', { prompt: NO_TERMINAL });

    expect(loweredConfirm()).toHaveLength(0);
    expect((await readMemory()).level).toBe('two-person');
  });
});

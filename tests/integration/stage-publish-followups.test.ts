import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
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

async function refExists(repo: string, ref: string): Promise<boolean> {
  const result = await $({
    cwd: repo,
    reject: false,
  })`git rev-parse --verify --quiet ${ref}`;
  return result.exitCode === 0;
}

async function commitFile(
  file: string,
  content: string,
  message: string
): Promise<void> {
  await Bun.write(`${fx.work}/${file}`, content);
  await fx.git(fx.work, 'add', '--', file);
  await fx.git(fx.work, 'commit', '--quiet', '-m', message);
}

async function featureFrom(base: string): Promise<void> {
  await fx.git(fx.work, 'fetch', '--quiet', 'origin');
  await fx.git(fx.work, 'fetch', '--quiet', 'upstream');
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature', base);
}

async function expectRefused(message: string): Promise<void> {
  await expect(stageCommand('feature')).rejects.toThrow(
    new CommandExitError(1)
  );
  expect(prompts.log.error).toHaveBeenCalledWith(
    expect.stringContaining(message)
  );
  expect(await refExists(fx.publicFork ?? '', 'refs/heads/feature')).toBe(
    false
  );
}

async function expectShipped(file: string, content: string): Promise<void> {
  await stageCommand('feature');
  expect(await fx.fileAt(fx.publicFork ?? '', 'feature', file)).toBe(content);
}

describe('the branch name is checked', () => {
  test('a branch name that mentions venfork is refused', async () => {
    await fx.git(fx.work, 'checkout', '--quiet', '-b', 'venfork-client-plan');

    await expect(stageCommand('venfork-client-plan')).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('the branch name')
    );
  });
});

describe('the self-reference opt-out', () => {
  const saved = process.env.VENFORK_ALLOW_SELF_REFERENCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.VENFORK_ALLOW_SELF_REFERENCE;
    else process.env.VENFORK_ALLOW_SELF_REFERENCE = saved;
  });

  test('without it a commit message with the word venfork is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', 'feat: add a venfork integration');

    await expectRefused("contains 'venfork'");
  });

  test('with it that commit ships', async () => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', 'feat: add a venfork integration');

    await expectShipped('src/a.txt', 'a\n');
  });

  test('with it a commit message naming the mirror URL is still refused', async () => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', `feat: a\n\nSee ${fx.origin}`);

    await expectRefused(fx.origin);
  });
});

describe('the preview', () => {
  test('warns about issue references in commit messages and lists the files', async () => {
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', 'feat: a (#42)\n\nFixes #7');
    await commitFile('src/b.txt', 'b\n', 'feat: b');

    await stageCommand('feature');

    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '1 commit message(s) reference issue/PR numbers that will resolve against upstream'
      )
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining('Files (2)'),
      'Staging Details'
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining('src/b.txt'),
      'Staging Details'
    );
  });
});

describe('cherry-pick failures', () => {
  test('report what git said', async () => {
    const base = await fx.commitOnUpstream({ 'src/x.txt': 'one\n' });
    await featureFrom(base);
    await commitFile('src/x.txt', 'two\n', 'feat: two');
    await fx.commitOnUpstream({ 'src/x.txt': 'three\n' });

    await expectRefused('could not apply');
  });
});

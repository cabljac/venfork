import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand, syncCommand } from '../../src/commands.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';
import { seedPreserve } from '../harness/preserve.js';

const DOC = 'docs/internal.md';
const BOT = [
  '-c',
  'user.name=venfork-bot',
  '-c',
  'user.email=venfork-bot@users.noreply.github.com',
];

let fx: MirrorFixture;
let active: MirrorFixture | undefined;
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await active?.cleanup();
  active = undefined;
});

/** The bare repo stage pushes to in the current fixture's mode. */
function target(): string {
  return fx.publicFork ?? fx.upstream;
}

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
  message: string,
  gitArgs: string[] = []
): Promise<void> {
  await Bun.write(`${fx.work}/${file}`, content);
  await fx.git(fx.work, 'add', '--', file);
  await fx.git(fx.work, ...gitArgs, 'commit', '--quiet', '-m', message);
}

async function featureFrom(base: string): Promise<void> {
  await fx.git(fx.work, 'fetch', '--quiet', 'origin');
  await fx.git(fx.work, 'fetch', '--quiet', 'upstream');
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature', base);
}

/** Every author, committer and message published on `range` of `repo`. */
async function publishedText(repo: string, range: string): Promise<string> {
  return (
    await $({ cwd: repo })`git log --format=%an%n%ae%n%cn%n%ce%n%B ${range}`
  ).stdout;
}

async function expectRefused(branch: string, message: string): Promise<void> {
  await expect(stageCommand(branch)).rejects.toThrow('process.exit(1)');
  expect(prompts.log.error).toHaveBeenCalledWith(
    expect.stringContaining(message)
  );
  expect(await refExists(target(), `refs/heads/${branch}`)).toBe(false);
}

describe.each(['standard', 'no-public'] as const)(
  'stage publishes only a gated linear rebuild (%s)',
  (mode) => {
    beforeEach(async () => {
      fx = await createMirrorFixture({ mode });
      active = fx;
      process.chdir(fx.work);
    });

    test('a clean branch ships with the same tree and subjects', async () => {
      await featureFrom('upstream/main');
      await commitFile('src/a.txt', 'a\n', 'feat: a');
      await commitFile('src/b.txt', 'b\n', 'feat: b');

      await stageCommand('feature');

      expect(await fx.git(target(), 'rev-parse', 'feature^{tree}')).toBe(
        await fx.git(fx.work, 'rev-parse', 'feature^{tree}')
      );
      expect(await fx.subjects(target(), 'feature', 'main..feature')).toEqual([
        'feat: b',
        'feat: a',
      ]);
    });

    test('a merge commit naming the mirror is not shipped', async () => {
      await featureFrom('upstream/main');
      await commitFile('src/a.txt', 'a\n', 'feat: a');
      await fx.git(
        fx.work,
        'checkout',
        '--quiet',
        '-b',
        'side',
        'upstream/main'
      );
      await commitFile('src/b.txt', 'b\n', 'feat: b');
      await fx.git(fx.work, 'checkout', '--quiet', 'feature');
      await fx.git(
        fx.work,
        'merge',
        '--quiet',
        '--no-ff',
        'side',
        '-m',
        `Merge branch 'side' of ${fx.origin}`
      );

      await stageCommand('feature');

      const merges = await fx.git(
        target(),
        'rev-list',
        '--merges',
        'main..feature'
      );
      expect(merges).toBe('');
      expect(await publishedText(target(), 'main..feature')).not.toContain(
        fx.origin
      );
      expect(await fx.fileAt(target(), 'feature', 'src/b.txt')).toBe('b\n');
    });

    test('a commit message with internal markers is refused', async () => {
      await featureFrom('upstream/main');
      await commitFile(
        'src/a.txt',
        'a\n',
        'feat: a\n\n<!-- venfork:internal -->client plan<!-- /venfork:internal -->'
      );

      await expectRefused(
        'feature',
        'Rewrite the branch so no commit contains'
      );
    });

    test('a commit message naming the mirror URL is refused', async () => {
      await featureFrom('upstream/main');
      await commitFile('src/a.txt', 'a\n', `feat: a\n\nSee ${fx.origin}`);

      await expectRefused('feature', fx.origin);
    });

    test('a commit message with an issue reference ships unchanged', async () => {
      await featureFrom('upstream/main');
      await commitFile('src/a.txt', 'a\n', 'feat: a (#42)');

      await stageCommand('feature');

      expect(await fx.subjects(target(), 'feature', 'main..feature')).toEqual([
        'feat: a (#42)',
      ]);
    });

    test('a bot-authored commit is refused', async () => {
      await featureFrom('upstream/main');
      await commitFile('src/a.txt', 'a\n', 'feat: a', BOT);

      await expectRefused('feature', 'venfork bot');
    });

    test('a preserved file added and later removed is refused', async () => {
      await fx.commitOnOrigin({ [DOC]: 'client roadmap\n' }, 'docs: notes');
      await featureFrom('origin/main');
      await seedPreserve(fx, [DOC]);
      await fx.git(fx.work, 'rm', '--quiet', DOC);
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'chore: drop notes');

      await expectRefused('feature', `mirror-only path(s) ${DOC}`);
    });

    test('a renamed preserved file is refused', async () => {
      await fx.commitOnOrigin({ [DOC]: 'client roadmap\n' }, 'docs: notes');
      await featureFrom('origin/main');
      await seedPreserve(fx, [DOC]);
      await syncCommand(undefined, { cwd: fx.work, quiet: true });
      await fx.git(fx.work, 'mv', DOC, 'docs/renamed.md');
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'docs: rename');

      await expectRefused('feature', DOC);
    });

    test('a copy of a preserved file under a new path is refused', async () => {
      await fx.commitOnOrigin({ [DOC]: 'client roadmap\n' }, 'docs: notes');
      await seedPreserve(fx, [DOC]);
      await syncCommand(undefined, { cwd: fx.work, quiet: true });
      await featureFrom('origin/main');
      await commitFile('docs/copy.md', 'client roadmap\n', 'docs: copy');
      await fx.git(fx.work, 'rm', '--quiet', 'docs/copy.md');
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'docs: drop copy');

      await expectRefused('feature', 'docs/copy.md');
    });

    test('a preserved file added by a clean commit after sync is refused', async () => {
      await seedPreserve(fx, [DOC]);
      await fx.commitOnOrigin({ [DOC]: 'client roadmap\n' }, 'docs: notes');
      await syncCommand(undefined, { cwd: fx.work, quiet: true });
      await featureFrom('origin/main');
      await fx.git(fx.work, 'rm', '--quiet', DOC);
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'chore: drop');
      await commitFile(DOC, 'second draft\n', 'docs: re-add');

      await expectRefused('feature', `mirror-only path(s) ${DOC}`);
    });

    test('mirror content at a preserved path upstream also has is refused', async () => {
      await fx.commitOnUpstream({ [DOC]: 'upstream doc\n' }, 'docs: upstream');
      await seedPreserve(fx, [DOC]);
      await featureFrom('upstream/main');
      await commitFile(DOC, 'client roadmap\n', 'docs: tweak');

      await expectRefused('feature', `mirror-only path(s) ${DOC}`);
    });

    test("upstream's exact content at a preserved path ships", async () => {
      await fx.commitOnUpstream({ [DOC]: 'upstream doc\n' }, 'docs: upstream');
      await seedPreserve(fx, [DOC]);
      await featureFrom('upstream/main');
      await fx.git(fx.work, 'rm', '--quiet', DOC);
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'docs: drop');
      await commitFile(DOC, 'upstream doc\n', 'docs: restore');

      await stageCommand('feature');

      expect(await fx.fileAt(target(), 'feature', DOC)).toBe('upstream doc\n');
    });

    test("upstream's default branch is refused", async () => {
      await fx.git(fx.work, 'checkout', '--quiet', 'main');
      await commitFile('INTERNAL.md', 'internal\n', 'chore: internal');
      const before = await fx.sha(target(), 'main');

      await expect(stageCommand('main')).rejects.toThrow('process.exit(1)');

      expect(prompts.log.error).toHaveBeenCalledWith(
        expect.stringContaining("upstream's default branch")
      );
      expect(await fx.sha(target(), 'main')).toBe(before);
    });

    test('a tag is refused', async () => {
      await featureFrom('upstream/main');
      await commitFile('src/a.txt', 'a\n', 'feat: a');
      await fx.git(fx.work, 'tag', '-a', 'rel', '-m', 'release');
      await fx.git(fx.work, 'checkout', '--quiet', 'main');
      await fx.git(fx.work, 'branch', '--quiet', '-D', 'feature');

      await expectRefused('rel', 'not a local branch');
    });

    test('the config branch rebased onto upstream is refused by content', async () => {
      await fx.git(fx.work, 'fetch', '--quiet', 'origin');
      await fx.git(
        fx.work,
        'checkout',
        '--quiet',
        '-b',
        'cfg',
        'origin/venfork-config'
      );
      await fx.git(fx.work, 'rebase', '--quiet', 'upstream/main');

      await expectRefused('cfg', '.venfork/config.json');
    });

    test('push.followTags does not publish a mirror-only tag', async () => {
      await fx.git(fx.work, 'config', 'push.followTags', 'true');
      await featureFrom('upstream/main');
      await commitFile('src/a.txt', 'a\n', 'feat: a');
      await fx.git(fx.work, 'tag', '-a', 'review-1', '-m', 'approved');

      await stageCommand('feature');

      expect(await fx.git(target(), 'tag', '-l')).toBe('');
    });
  }
);

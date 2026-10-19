import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { appendFile, chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { ON_STDERR, quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { pullRequestCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

const PR = 7;
const BRANCH = `upstream-pr/${PR}`;
const PR_REF = `refs/pull/${PR}/head`;

let fx: MirrorFixture;
let upstreamDev: string;
let originDev: string;
const originalCwd = process.cwd();
const originalPath = process.env.PATH;

/**
 * Points `upstream` in `clone` at `acme/widget`, a symlink to upstream.git:
 * parseRepoPath reads it as owner/repo and git as a relative path.
 */
async function wireUpstream(clone: string): Promise<void> {
  await mkdir(path.join(clone, 'acme'), { recursive: true });
  await symlink(fx.upstream, path.join(clone, 'acme', 'widget'));
  await appendFile(path.join(clone, '.git', 'info', 'exclude'), 'acme/\n');
  await fx.git(clone, 'remote', 'set-url', 'upstream', 'acme/widget');
}

async function commitIn(
  repo: string,
  file: string,
  content: string,
  message: string
): Promise<string> {
  await writeFile(path.join(repo, file), content);
  await fx.git(repo, 'add', '--', file);
  await fx.git(repo, 'commit', '--quiet', '-m', message);
  return fx.git(repo, 'rev-parse', 'HEAD');
}

/** Commits on the PR source branch and force-updates `refs/pull/<n>/head`. */
async function advancePr(content: string, amend = false): Promise<string> {
  await writeFile(path.join(upstreamDev, 'pr.txt'), content);
  await fx.git(upstreamDev, 'add', 'pr.txt');
  await fx.git(
    upstreamDev,
    'commit',
    '--quiet',
    ...(amend ? ['--amend'] : []),
    '-m',
    `pr: ${content.trim()}`
  );
  await fx.git(
    upstreamDev,
    'push',
    '--quiet',
    '--force',
    'origin',
    `HEAD:${PR_REF}`
  );
  return fx.git(upstreamDev, 'rev-parse', 'HEAD');
}

async function tip(repo: string, ref: string): Promise<string> {
  const result = await $({
    cwd: repo,
    reject: false,
  })`git rev-parse --verify --quiet ${ref}`;
  return result.stdout.trim();
}

async function recordedHead(): Promise<unknown> {
  const config = await fx.readRawConfig();
  const pulled = config.pulledPrs as Record<string, { head: string }>;
  return pulled?.[BRANCH]?.head;
}

async function expectRefused(message: string): Promise<void> {
  await expect(pullRequestCommand(String(PR))).rejects.toThrow(
    new CommandExitError(1)
  );
  expect(prompts.log.error).toHaveBeenCalledWith(
    expect.stringContaining(message),
    ON_STDERR
  );
}

beforeEach(async () => {
  fx = await createMirrorFixture();
  upstreamDev = path.join(fx.root, 'upstream-dev');
  originDev = path.join(fx.root, 'origin-dev');
  const bin = path.join(fx.root, 'gh-bin');
  await mkdir(bin);
  const meta = JSON.stringify({
    number: PR,
    title: 'PR seven',
    body: 'b',
    url: `https://github.com/acme/widget/pull/${PR}`,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'feat',
    author: { login: 'x' },
    headRepositoryOwner: { login: 'x' },
  });
  await writeFile(
    path.join(bin, 'gh'),
    `#!/bin/sh\n[ "$1 $2" = "pr view" ] && { echo '${meta}'; exit 0; }\nexit 1\n`
  );
  await chmod(path.join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  await fx.git(upstreamDev, 'checkout', '--quiet', '-b', 'feat');
  await advancePr('pr 1\n');
  await wireUpstream(fx.work);
  process.chdir(fx.work);
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  await fx.cleanup();
});

describe('re-running pull pr refreshes the pulled copy', () => {
  test('a fast-forwarded PR moves the local branch, the mirror copy and the record', async () => {
    await pullRequestCommand(String(PR));
    const next = await advancePr('pr 2\n');

    const result = await pullRequestCommand(String(PR));

    expect(result).toMatchObject({ head: next, pushed: true, refreshed: true });
    expect(await tip(fx.work, BRANCH)).toBe(next);
    expect(await tip(fx.origin, BRANCH)).toBe(next);
    expect(await recordedHead()).toBe(next);
  });

  test('a rebased PR replaces the old PR commits', async () => {
    await pullRequestCommand(String(PR));
    const rebased = await advancePr('pr 1 rewritten\n', true);

    const result = await pullRequestCommand(String(PR));

    expect(result).toMatchObject({ head: rebased, refreshed: true });
    expect(await tip(fx.origin, BRANCH)).toBe(rebased);
  });

  test('a branch checked out in this worktree is moved to the new PR head', async () => {
    await pullRequestCommand(String(PR));
    await fx.git(fx.work, 'checkout', '--quiet', BRANCH);
    const next = await advancePr('pr 2\n');

    const result = await pullRequestCommand(String(PR));

    expect(result).toMatchObject({ head: next, refreshed: true });
    expect(await tip(fx.work, 'HEAD')).toBe(next);
    expect(await fx.git(fx.work, 'symbolic-ref', 'HEAD')).toBe(
      `refs/heads/${BRANCH}`
    );
    expect(await fx.git(fx.work, 'status', '--porcelain')).toBe('');
    expect(await tip(fx.origin, BRANCH)).toBe(next);
  });

  test('uncommitted changes the new PR head would overwrite are refused and kept', async () => {
    await pullRequestCommand(String(PR));
    await fx.git(fx.work, 'checkout', '--quiet', BRANCH);
    const before = await tip(fx.work, BRANCH);
    await advancePr('pr 2\n');
    await writeFile(path.join(fx.work, 'pr.txt'), 'my edit\n');

    await expectRefused('uncommitted changes');

    expect(await tip(fx.work, BRANCH)).toBe(before);
    expect(await tip(fx.origin, BRANCH)).toBe(before);
    expect(await Bun.file(path.join(fx.work, 'pr.txt')).text()).toBe(
      'my edit\n'
    );
  });

  test('a branch checked out in another worktree is refused', async () => {
    await pullRequestCommand(String(PR));
    const before = await tip(fx.work, BRANCH);
    await fx.git(
      fx.work,
      'worktree',
      'add',
      '--quiet',
      path.join(fx.root, 'wt'),
      BRANCH
    );
    await advancePr('pr 2\n');

    await expectRefused('checked out in another worktree');

    expect(await tip(fx.work, BRANCH)).toBe(before);
  });

  test('unpushed local commits on the branch are refused and kept', async () => {
    await pullRequestCommand(String(PR));
    await fx.git(fx.work, 'checkout', '--quiet', BRANCH);
    const review = await commitIn(fx.work, 'review.txt', 'r\n', 'my review');
    await fx.git(fx.work, 'checkout', '--quiet', fx.defaultBranch);

    await expectRefused('1 commit(s) on upstream-pr/7');

    expect(await tip(fx.work, BRANCH)).toBe(review);
  });

  test('a teammate commit on the mirror copy is not overwritten after git fetch', async () => {
    await pullRequestCommand(String(PR));
    await fx.git(originDev, 'fetch', '--quiet', 'origin');
    await fx.git(
      originDev,
      'checkout',
      '--quiet',
      '-b',
      BRANCH,
      `origin/${BRANCH}`
    );
    const mate = await commitIn(originDev, 'mate.txt', 'm\n', 'teammate');
    await fx.git(originDev, 'push', '--quiet', 'origin', BRANCH);
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await advancePr('pr 2\n');

    await expectRefused('1 commit(s) on origin/upstream-pr/7');

    expect(await tip(fx.origin, BRANCH)).toBe(mate);
  });

  test('a second clone with no local branch refreshes a rebased PR on the first run', async () => {
    await pullRequestCommand(String(PR));
    const second = path.join(fx.root, 'second');
    await $`git clone --quiet ${fx.origin} ${second}`;
    await fx.git(second, 'remote', 'add', 'upstream', fx.upstream);
    await fx.git(second, 'remote', 'set-url', '--push', 'upstream', 'DISABLE');
    await wireUpstream(second);
    const rebased = await advancePr('pr 1 rewritten\n', true);
    process.chdir(second);

    const result = await pullRequestCommand(String(PR));

    expect(result).toMatchObject({
      head: rebased,
      pushed: true,
      refreshed: true,
    });
    expect(await tip(second, `refs/heads/${BRANCH}`)).toBe(rebased);
    expect(await tip(fx.origin, BRANCH)).toBe(rebased);
    expect(await recordedHead()).toBe(rebased);
  });

  test('--no-push moves only the local branch and keeps the record', async () => {
    const first = await pullRequestCommand(String(PR));
    const next = await advancePr('pr 2\n');

    const result = await pullRequestCommand(String(PR), { push: false });

    expect(result).toMatchObject({ head: next, pushed: false });
    expect(await tip(fx.work, BRANCH)).toBe(next);
    expect(await tip(fx.origin, BRANCH)).toBe(first.head);
    expect(await recordedHead()).toBe(first.head);
  });

  test('with no pulledPrs record, a rebased PR is refused instead of guessing which commits are the PR', async () => {
    const first = await pullRequestCommand(String(PR), { push: false });
    await advancePr('pr 1 rewritten\n', true);

    await expect(
      pullRequestCommand(String(PR), { push: false })
    ).rejects.toThrow(new CommandExitError(1));

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('1 commit(s) on upstream-pr/7'),
      ON_STDERR
    );
    expect(await tip(fx.work, BRANCH)).toBe(first.head);
  });

  test('a re-run with no PR change reports refreshed and keeps the head', async () => {
    const first = await pullRequestCommand(String(PR));

    const result = await pullRequestCommand(String(PR));

    expect(result).toMatchObject({ head: first.head, refreshed: true });
    expect(await tip(fx.origin, BRANCH)).toBe(first.head);
  });

  test('staged changes on a checked-out branch are refused and stay staged', async () => {
    await pullRequestCommand(String(PR));
    await fx.git(fx.work, 'checkout', '--quiet', BRANCH);
    const before = await tip(fx.work, BRANCH);
    await advancePr('pr 2\n');
    await writeFile(path.join(fx.work, 'mine.txt'), 'staged\n');
    await fx.git(fx.work, 'add', 'mine.txt');

    await expectRefused('staged changes');

    expect(await tip(fx.work, BRANCH)).toBe(before);
    expect(await tip(fx.origin, BRANCH)).toBe(before);
    expect(await fx.git(fx.work, 'status', '--porcelain')).toBe('A  mine.txt');
  });

  test('a clone left behind a teammate refresh of a rebased PR refreshes without refusal', async () => {
    await pullRequestCommand(String(PR));
    const second = path.join(fx.root, 'second');
    await $`git clone --quiet ${fx.origin} ${second}`;
    await fx.git(second, 'remote', 'add', 'upstream', fx.upstream);
    await wireUpstream(second);
    const rebased = await advancePr('pr 1 rewritten\n', true);
    process.chdir(second);
    await pullRequestCommand(String(PR));
    process.chdir(fx.work);

    const result = await pullRequestCommand(String(PR));

    expect(result).toMatchObject({ head: rebased, refreshed: true });
    expect(await tip(fx.work, BRANCH)).toBe(rebased);
    expect(await tip(fx.origin, BRANCH)).toBe(rebased);
  });

  test('a failed push names the same --branch-name, and that re-run lands the branch', async () => {
    const custom = 'review/seven';
    await fx.git(fx.work, 'remote', 'set-url', '--push', 'origin', fx.root);

    const failed = await pullRequestCommand(String(PR), {
      branchName: custom,
    });

    expect(failed).toMatchObject({ branch: custom, pushed: false });
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `run \`venfork pull pr ${PR} --branch-name '${custom}'\` again`
      ),
      ON_STDERR
    );
    await fx.git(fx.work, 'remote', 'set-url', '--push', 'origin', fx.origin);

    const result = await pullRequestCommand(String(PR), {
      branchName: custom,
    });

    expect(result).toMatchObject({ branch: custom, pushed: true });
    expect(await tip(fx.origin, custom)).toBe(failed.head);
  });
});

describe('pull pr does not take over a branch that is not the PR copy', () => {
  async function expectNameRefused(
    branchName: string,
    message: string
  ): Promise<void> {
    await expect(
      pullRequestCommand(String(PR), { branchName })
    ).rejects.toThrow(CommandExitError);
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(message),
      ON_STDERR
    );
  }

  test('--branch-name naming the checked-out default branch is refused and moves nothing', async () => {
    const main = fx.defaultBranch;
    const local = await tip(fx.work, `refs/heads/${main}`);
    const origin = await tip(fx.origin, main);

    await expectNameRefused(main, 'default branch');

    expect(await tip(fx.work, `refs/heads/${main}`)).toBe(local);
    expect(await tip(fx.origin, main)).toBe(origin);
    expect(await fx.readRawConfig()).not.toHaveProperty(`pulledPrs.${main}`);
  });

  test('--branch-name naming an existing branch that is not a pulled copy is refused and moves nothing', async () => {
    await fx.git(fx.work, 'branch', 'dev');
    await fx.git(fx.work, 'push', '--quiet', 'origin', 'dev');
    const before = await tip(fx.work, 'refs/heads/dev');

    await expectNameRefused('dev', "Local branch 'dev' already exists");

    expect(await tip(fx.work, 'refs/heads/dev')).toBe(before);
    expect(await tip(fx.origin, 'dev')).toBe(before);
  });

  test('--branch-name naming a branch only origin has is refused and leaves origin as is', async () => {
    await fx.git(fx.work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/dev');
    const before = await tip(fx.origin, 'dev');

    await expectNameRefused('dev', "Branch 'dev' already exists on origin");

    expect(await tip(fx.origin, 'dev')).toBe(before);
    expect(await tip(fx.work, 'refs/heads/dev')).toBe('');
  });
});

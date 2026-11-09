import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { appendFile, chmod, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { ON_STDERR, quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import {
  runDoctorChecks,
  stageCommand,
  syncCommand,
} from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import { githubMirror, MIRROR_REPO } from '../harness/gh-mirror.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';
import { seedPreserve } from '../harness/preserve.js';

const CALLER = '.github/workflows/caller.yml';

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

async function cutFeatureBranch(base: string): Promise<string> {
  await fx.git(fx.work, 'fetch', '--quiet', 'origin');
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature', base);
  await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
  await fx.git(fx.work, 'add', 'src/feature.txt');
  await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: feature work');
  return fx.sha(fx.work, 'feature');
}

describe('stage against real repos', () => {
  test('a post-checkout hook in the clone does not leak into the staged branch', async () => {
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand({ cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');
    const hook = `${fx.work}/.git/hooks/post-checkout`;
    await Bun.write(
      hook,
      '#!/bin/sh\necho hooked > hooked.txt\ngit add hooked.txt\n'
    );
    await chmod(hook, 0o755);

    await stageCommand('feature');

    expect(
      await fx.fileAt(fx.publicFork ?? '', 'feature', 'hooked.txt')
    ).toBeNull();
  });

  test('stage strips a preserve-only managed commit', async () => {
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand({ cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');

    await stageCommand('feature');

    const publicFork = fx.publicFork ?? '';
    const upstreamTip = await fx.sha(fx.upstream, 'main');
    expect(await fx.subjects(publicFork, 'feature', 'main..feature')).toEqual([
      'feat: feature work',
    ]);
    expect(await fx.sha(publicFork, 'feature~1')).toBe(upstreamTip);
    expect(await fx.fileAt(publicFork, 'feature', CALLER)).toBeNull();
    expect(await fx.fileAt(publicFork, 'feature', 'src/feature.txt')).toBe(
      'feature\n'
    );
  });

  test('stage rebuilds a branch with no managed commit on upstream, so its SHA changes but its tree does not', async () => {
    await cutFeatureBranch('upstream/main');
    await fx.commitOnUpstream({ 'src/later.txt': 'later\n' });

    await stageCommand('feature');

    const publicFork = fx.publicFork ?? '';
    expect(await fx.sha(publicFork, 'feature~1')).toBe(
      await fx.sha(fx.upstream, 'main')
    );
    expect(await fx.fileAt(publicFork, 'feature', 'src/feature.txt')).toBe(
      'feature\n'
    );
  });

  test('stage re-pushes a rebuilt branch when the public tracking ref is missing', async () => {
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand({ cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');
    await stageCommand('feature');
    await fx.git(fx.work, 'commit', '--quiet', '--amend', '-m', 'feat: v2');
    await fx.git(fx.work, 'update-ref', '-d', 'refs/remotes/public/feature');

    await stageCommand('feature');

    expect(
      await fx.subjects(fx.publicFork ?? '', 'feature', 'main..feature')
    ).toEqual(['feat: v2']);
  });

  test('stage names the preserved path when a commit touching it cannot be replayed', async () => {
    await seedPreserve(fx, [CALLER]);
    await fx.commitOnOrigin({ [CALLER]: 'mirror only\n' });
    await syncCommand({ cwd: fx.work, quiet: true });
    await cutFeatureBranch('origin/main');
    await Bun.write(`${fx.work}/${CALLER}`, 'edited on the branch\n');
    await fx.git(fx.work, 'commit', '--quiet', '-am', 'chore: tweak caller');

    await expect(stageCommand('feature')).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(`preserved mirror-only path(s) ${CALLER}`),
      ON_STDERR
    );
  });
});

const DOC = 'docs/a.md';

/** The bare repo stage pushes to in the current fixture's mode. */
function pushTarget(): string {
  return fx.publicFork ?? fx.upstream;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  const result = await $({
    cwd: repo,
    reject: false,
  })`git rev-parse --verify --quiet ${ref}`;
  return result.exitCode === 0;
}

async function useMode(mode: 'standard' | 'no-public'): Promise<void> {
  if (mode === 'standard') return;
  process.chdir(originalCwd);
  await active?.cleanup();
  fx = await createMirrorFixture({ mode });
  active = fx;
  process.chdir(fx.work);
}

async function expectLeakRefused(): Promise<void> {
  await expect(stageCommand('feature')).rejects.toThrow(
    new CommandExitError(1)
  );
  expect(prompts.log.error).toHaveBeenCalledWith(
    expect.stringContaining(`mirror-only path(s) ${DOC}`),
    ON_STDERR
  );
  expect(await refExists(pushTarget(), 'refs/heads/feature')).toBe(false);
}

describe.each(['standard', 'no-public'] as const)(
  'stage refuses to publish mirror-only paths (%s)',
  (mode) => {
    beforeEach(async () => {
      await useMode(mode);
      await seedPreserve(fx, [DOC]);
    });

    test('a branch cut before sync from a teammate commit of a preserved file', async () => {
      await fx.commitOnOrigin({ [DOC]: 'mirror only\n' });
      await cutFeatureBranch('origin/main');

      await expectLeakRefused();
    });

    test('a branch squashed onto upstream after sync', async () => {
      await fx.commitOnOrigin({ [DOC]: 'mirror only\n' });
      await syncCommand({ cwd: fx.work, quiet: true });
      await cutFeatureBranch('origin/main');
      await fx.git(fx.work, 'reset', '--quiet', '--soft', 'upstream/main');
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: squashed');

      await expectLeakRefused();
    });

    test('a cherry-picked commit that adds a preserved file', async () => {
      const teammate = await fx.commitOnOrigin({ [DOC]: 'mirror only\n' });
      await cutFeatureBranch('upstream/main');
      await fx.git(fx.work, 'cherry-pick', teammate);

      await expectLeakRefused();
    });
  }
);

describe('stage refuses branches that are not upstream work', () => {
  test('the venfork-config branch', async () => {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(fx.work, 'branch', 'venfork-config', 'origin/venfork-config');

    await expect(stageCommand('venfork-config')).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining("holds venfork's private configuration"),
      ON_STDERR
    );
    expect(await refExists(pushTarget(), 'refs/heads/venfork-config')).toBe(
      false
    );
  });

  test('a branch with no history in common with upstream', async () => {
    await fx.git(fx.work, 'checkout', '--quiet', '--orphan', 'lonely');
    await Bun.write(`${fx.work}/lonely.txt`, 'alone\n');
    await fx.git(fx.work, 'add', 'lonely.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: lonely');

    await expect(stageCommand('lonely')).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('no history in common with upstream/main'),
      ON_STDERR
    );
    expect(await refExists(pushTarget(), 'refs/heads/lonely')).toBe(false);
  });
});

describe('stage --base', () => {
  async function cutFromUpstreamGa(): Promise<string> {
    await fx.commitOnUpstreamBranch(
      'ga',
      { 'src/ga.txt': 'ga only\n' },
      'feat: ga only'
    );
    await fx.commitOnUpstream({ 'src/main-later.txt': 'main only\n' });
    await fx.git(fx.work, 'fetch', '--quiet', 'upstream');
    return cutFeatureBranch('upstream/ga');
  }

  test('rebuilds the branch on upstream/<base>, not the default branch', async () => {
    await cutFromUpstreamGa();

    await stageCommand('feature', { base: 'ga' });

    const publicFork = fx.publicFork ?? '';
    expect(await fx.sha(publicFork, 'feature~1')).toBe(
      await fx.sha(fx.upstream, 'ga')
    );
    expect(await fx.fileAt(publicFork, 'feature', 'src/ga.txt')).toBe(
      'ga only\n'
    );
    expect(
      await fx.fileAt(publicFork, 'feature', 'src/main-later.txt')
    ).toBeNull();
  });

  test('a dry run reports the base and only the commits beyond it', async () => {
    await cutFromUpstreamGa();

    const result = await stageCommand('feature', { base: 'ga', dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      base: 'ga',
      commits: ['feat: feature work'],
      files: ['src/feature.txt'],
    });
  });

  test('a branch with nothing beyond upstream/<base> is "Nothing to stage"', async () => {
    await cutFromUpstreamGa();
    await fx.git(fx.work, 'reset', '--quiet', '--hard', 'upstream/ga');

    await expect(stageCommand('feature', { base: 'ga' })).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('beyond upstream/ga'),
      ON_STDERR
    );
    expect(await refExists(pushTarget(), 'refs/heads/feature')).toBe(false);
  });

  test('a base upstream does not have is refused', async () => {
    await cutFeatureBranch('upstream/main');

    await expect(stageCommand('feature', { base: 'nope' })).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('upstream/nope not found after fetch'),
      ON_STDERR
    );
    expect(await refExists(pushTarget(), 'refs/heads/feature')).toBe(false);
  });

  test('the --base branch itself is refused', async () => {
    await cutFromUpstreamGa();
    await fx.git(fx.work, 'branch', '--quiet', 'ga', 'feature');

    await expect(stageCommand('ga', { base: 'ga' })).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining('it is the --base branch'),
      ON_STDERR
    );
    expect(await refExists(pushTarget(), 'refs/heads/ga')).toBe(false);
  });
});

describe('stage in no-public mode', () => {
  test('pushes a clean branch straight to upstream', async () => {
    await useMode('no-public');
    await cutFeatureBranch('upstream/main');

    await stageCommand('feature');

    expect(await fx.git(fx.upstream, 'rev-parse', 'feature^{tree}')).toBe(
      await fx.git(fx.work, 'rev-parse', 'feature^{tree}')
    );
  });
});

describe('stage a pinned commit', () => {
  test('source.sha stages a commit that has no local branch', async () => {
    const sha = await cutFeatureBranch('upstream/main');
    await fx.git(fx.work, 'checkout', '--quiet', 'main');
    await fx.git(fx.work, 'branch', '--quiet', '-D', 'feature');

    await stageCommand('feature', { source: { sha } });

    const publicFork = fx.publicFork ?? '';
    expect(await fx.git(publicFork, 'rev-parse', 'feature^{tree}')).toBe(
      await fx.git(fx.work, 'rev-parse', `${sha}^{tree}`)
    );
    expect(await fx.subjects(publicFork, 'feature', 'main..feature')).toEqual([
      'feat: feature work',
    ]);
    expect(await refExists(fx.work, 'refs/heads/feature')).toBe(false);
  });

  test('source.sha stages the pinned commit, not the moved local branch', async () => {
    const sha = await cutFeatureBranch('upstream/main');
    await Bun.write(`${fx.work}/src/later.txt`, 'later\n');
    await fx.git(fx.work, 'add', 'src/later.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: later work');

    await stageCommand('feature', { source: { sha } });

    const publicFork = fx.publicFork ?? '';
    expect(await fx.fileAt(publicFork, 'feature', 'src/later.txt')).toBeNull();
    expect(await fx.git(publicFork, 'rev-parse', 'feature^{tree}')).toBe(
      await fx.git(fx.work, 'rev-parse', `${sha}^{tree}`)
    );
  });

  test('source.sha refuses a commit that is not in the clone', async () => {
    await expect(
      stageCommand('feature', { source: { sha: 'f'.repeat(40) } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(`commit ${'f'.repeat(40)} is not in this clone`),
      ON_STDERR
    );
    expect(await refExists(pushTarget(), 'refs/heads/feature')).toBe(false);
  });
});

describe('stage reads the local branch once', () => {
  /** Commits twice on `feature`, rewinds it one commit, and arms a hook that moves it forward again during the upstream fetch. */
  async function armMoveDuringFetch(): Promise<{
    planned: string;
    marker: string;
  }> {
    const planned = await cutFeatureBranch('upstream/main');
    await Bun.write(`${fx.work}/src/later.txt`, 'later\n');
    await fx.git(fx.work, 'add', 'src/later.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: later work');
    const later = await fx.sha(fx.work, 'feature');
    await fx.git(fx.work, 'checkout', '--quiet', '--detach');
    await fx.git(fx.work, 'branch', '-f', 'feature', planned);
    await fx.commitOnUpstream({ 'up.txt': 'up\n' });
    const marker = `${fx.root}/moved`;
    const hook = `${fx.work}/.git/hooks/reference-transaction`;
    await Bun.write(
      hook,
      `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e '${marker}' ] && exit 0\nif grep -q refs/remotes/upstream; then touch '${marker}'; git update-ref refs/heads/feature ${later}; fi\nexit 0\n`
    );
    await chmod(hook, 0o755);
    return { planned, marker };
  }

  test('a branch moved during the upstream fetch ships the planned head, not the new tip', async () => {
    const { marker } = await armMoveDuringFetch();

    await stageCommand('feature');

    expect(await Bun.file(marker).exists()).toBe(true);
    const publicFork = fx.publicFork ?? '';
    expect(await fx.fileAt(publicFork, 'feature', 'src/later.txt')).toBeNull();
    expect(await fx.fileAt(publicFork, 'feature', 'src/feature.txt')).toBe(
      'feature\n'
    );
  });

  test('the PR step records the planned head as sourceHead when the branch moves during the fetch', async () => {
    const { planned, marker } = await armMoveDuringFetch();
    await mkdir(path.join(fx.work, 'acme'));
    for (const [name, target] of [
      ['upstream', fx.upstream],
      ['public', fx.publicFork ?? ''],
    ] as const) {
      await symlink(target, path.join(fx.work, 'acme', name));
      await fx.git(fx.work, 'remote', 'set-url', name, `acme/${name}`);
    }
    await appendFile(path.join(fx.work, '.git', 'info', 'exclude'), 'acme/\n');
    const bin = path.join(fx.root, 'gh-bin');
    await mkdir(bin);
    await Bun.write(
      path.join(bin, 'gh'),
      '#!/bin/sh\n[ "$1 $2" = "pr create" ] && { echo https://github.com/acme/upstream/pull/1; exit 0; }\nexit 1\n'
    );
    await chmod(path.join(bin, 'gh'), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    try {
      await stageCommand('feature', { createPr: true });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(await Bun.file(marker).exists()).toBe(true);
    const shipped = (await fx.readRawConfig()).shippedBranches as
      | Record<string, { sourceHead?: string; head?: string }>
      | undefined;
    const publicFork = fx.publicFork ?? '';
    expect(shipped?.feature?.sourceHead).toBe(planned);
    expect(shipped?.feature?.head).toBe(await fx.sha(publicFork, 'feature'));
    expect(await fx.fileAt(publicFork, 'feature', 'src/later.txt')).toBeNull();
  });
});

describe('stage lists AI attribution in commit messages', () => {
  const MESSAGE =
    'feat: feature work\n\nCo-authored-by: Claude <noreply@anthropic.com>';

  async function aiCommit(): Promise<void> {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(
      fx.work,
      'checkout',
      '--quiet',
      '-b',
      'feature',
      'origin/main'
    );
    await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
    await fx.git(fx.work, 'add', 'src/feature.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', MESSAGE);
  }

  test('--dry-run reports the trailer in the result and the preview', async () => {
    await aiCommit();

    const result = await stageCommand('feature', { dryRun: true });

    expect(result).toMatchObject({
      aiAttribution: [
        {
          subject: 'feat: feature work',
          line: 'Co-authored-by: Claude <noreply@anthropic.com>',
        },
      ],
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining('AI attribution (1), published as is:'),
      'Staging Details',
      ON_STDERR
    );
  });

  test('--dry-run reports an AI tool as the commit author', async () => {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(
      fx.work,
      'checkout',
      '--quiet',
      '-b',
      'feature',
      'origin/main'
    );
    await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
    await fx.git(fx.work, 'add', 'src/feature.txt');
    const copilot = 'Copilot <198982749+Copilot@users.noreply.github.com>';
    await fx.git(
      fx.work,
      'commit',
      '--quiet',
      '--author',
      copilot,
      '-m',
      'feat: feature work'
    );

    const result = await stageCommand('feature', { dryRun: true });

    expect(result).toMatchObject({
      aiAttribution: [
        {
          where: 'commit-author',
          subject: 'feat: feature work',
          line: copilot,
        },
      ],
    });
  });

  test('--dry-run reports AI lines in the PR title and body it would publish', async () => {
    await cutFeatureBranch('origin/main');
    await mkdir(path.join(fx.work, 'acme'));
    for (const [name, target] of [
      ['upstream', fx.upstream],
      ['public', fx.publicFork ?? ''],
    ] as const) {
      await symlink(target, path.join(fx.work, 'acme', name));
      await fx.git(fx.work, 'remote', 'set-url', name, `acme/${name}`);
    }
    await appendFile(path.join(fx.work, '.git', 'info', 'exclude'), 'acme/\n');
    const gh = await githubMirror(fx);
    await gh.setRoutes([
      {
        match: `pr list --repo ${MIRROR_REPO} --head feature --state open`,
        stdout: JSON.stringify([
          {
            number: 7,
            url: `https://github.com/${MIRROR_REPO}/pull/7`,
            title: 'internal title',
            body: 'Adds the feature.\n\nCo-authored-by: Claude <noreply@anthropic.com>',
          },
        ]),
      },
    ]);

    const result = await stageCommand('feature', {
      dryRun: true,
      createPr: true,
      title: 'feat: feature work (Generated with Claude Code)',
    });

    expect(result).toMatchObject({
      aiAttribution: [
        {
          where: 'pr-title',
          line: 'feat: feature work (Generated with Claude Code)',
        },
        {
          where: 'pr-body',
          line: 'Co-authored-by: Claude <noreply@anthropic.com>',
        },
      ],
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining(
        'Co-authored-by: Claude <noreply@anthropic.com> (PR body)'
      ),
      'Staging Details',
      ON_STDERR
    );
  });

  test('a real stage warns and publishes the message unchanged', async () => {
    await aiCommit();

    const result = await stageCommand('feature', {
      prompt: { yes: true, noInput: true },
    });

    expect(result).toMatchObject({
      aiAttribution: [
        {
          where: 'commit-message',
          line: 'Co-authored-by: Claude <noreply@anthropic.com>',
        },
      ],
    });

    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('credit an AI tool'),
      ON_STDERR
    );
    expect(
      await fx.git(fx.publicFork ?? '', 'log', '-1', '--format=%B', 'feature')
    ).toBe(MESSAGE);
  });
});

describe('stage refuses the mirror deny list (denyTerms)', () => {
  async function denyList(denyTerms: unknown[]) {
    const config = await fx.readRawConfig();
    await fx.writeRawConfig(JSON.stringify({ ...config, denyTerms }));
  }

  async function commitFeature(
    files: Record<string, string>,
    message = 'feat: feature work',
    branch = 'feature'
  ): Promise<void> {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(fx.work, 'checkout', '--quiet', '-b', branch, 'origin/main');
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fx.work, file)), { recursive: true });
      await Bun.write(path.join(fx.work, file), content);
      await fx.git(fx.work, 'add', file);
    }
    await fx.git(fx.work, 'commit', '--quiet', '-m', message);
  }

  async function expectRefused(
    branch: string,
    where: string,
    matched: string
  ): Promise<void> {
    const error = await stageCommand(branch).catch((err: unknown) => err);
    expect(error).toMatchObject({
      cause: {
        code: 'mirror-reference',
        details: { matched, list: 'custom' },
      },
    });
    expect(
      (error as { cause: { details: { where: string } } }).cause.details.where
    ).toContain(where);
    expect(await refExists(pushTarget(), `refs/heads/${branch}`)).toBe(false);
  }

  test('an added line with a deny term is refused, ignoring case', async () => {
    await denyList(['Globex']);
    await commitFeature({ 'src/feature.txt': 'thanks GLOBEX team\n' });

    await expectRefused('feature', 'file src/feature.txt', 'Globex');
  });

  test('an added line that looks like a diff header is still checked', async () => {
    await denyList(['Globex']);
    await commitFeature({
      'docs/a.md': 'intro\n++ Globex here\n',
    });

    await expectRefused('feature', 'file docs/a.md', 'Globex');
  });

  test('a line after an added "+++ b/<path>" line keeps its own file name', async () => {
    await denyList(['Globex']);
    await commitFeature({
      'docs/a.md': '++ b/other.txt\nGlobex\n',
    });

    await expectRefused('feature', 'file docs/a.md', 'Globex');
  });

  async function commitMore(
    files: Record<string, string | null>,
    message: string
  ): Promise<void> {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        await fx.git(fx.work, 'rm', '--quiet', file);
      } else {
        await Bun.write(path.join(fx.work, file), content);
        await fx.git(fx.work, 'add', file);
      }
    }
    await fx.git(fx.work, 'commit', '--quiet', '-m', message);
  }

  test('a term added in one commit and removed in the next is still refused', async () => {
    await denyList(['Globex']);
    await commitFeature({ 'src/feature.txt': 'hello Globex\n' });
    await commitMore({ 'src/feature.txt': 'hello\n' }, 'fix: drop the name');

    await expectRefused('feature', 'file src/feature.txt', 'Globex');
  });

  test('a term only in an intermediate commit among several is refused', async () => {
    await denyList(['Globex']);
    await commitFeature({ 'src/a.txt': 'one\n' });
    await commitMore({ 'src/b.txt': 'two Globex\n' }, 'feat: two');
    await commitMore({ 'src/b.txt': 'two\n' }, 'feat: three');
    await commitMore({ 'src/c.txt': 'four\n' }, 'feat: four');

    await expectRefused('feature', 'file src/b.txt', 'Globex');
  });

  test('a file whose name has a term, added then deleted, is still refused', async () => {
    await denyList(['Globex']);
    await commitFeature({ 'docs/globex-notes.md': 'notes\n' });
    await commitMore({ 'docs/globex-notes.md': null }, 'chore: remove notes');

    await expectRefused('feature', 'file name docs/globex-notes.md', 'Globex');
  });

  test('a term that only an upstream line already has is not refused', async () => {
    await fx.commitOnUpstream({ 'src/notes.txt': 'globex\nkeep\n' });
    await denyList(['globex']);
    await fx.git(fx.work, 'fetch', '--quiet', 'upstream');
    await fx.git(
      fx.work,
      'checkout',
      '--quiet',
      '-b',
      'feature',
      'upstream/main'
    );
    await Bun.write(`${fx.work}/src/notes.txt`, 'globex\nkeep\nmore\n');
    await fx.git(fx.work, 'add', 'src/notes.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: more notes');

    await stageCommand('feature');

    expect(await refExists(pushTarget(), 'refs/heads/feature')).toBe(true);
  });

  test('a deny term in the commit message is refused', async () => {
    await denyList(['GLX-42']);
    await commitFeature(
      { 'src/feature.txt': 'feature\n' },
      'feat: feature work\n\nRefs glx-42'
    );

    await expectRefused('feature', 'message', 'GLX-42');
  });

  test('a text file marked -diff in .gitattributes is still scanned', async () => {
    await denyList(['Globex']);
    await commitFeature({
      '.gitattributes': 'gen.txt -diff\n',
      'gen.txt': 'generated\nGlobex inside\n',
    });

    await expectRefused('feature', 'file gen.txt', 'Globex');
  });

  test('a binary file is scanned as text, so a term in its bytes is refused', async () => {
    await denyList(['Globex']);
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(
      fx.work,
      'checkout',
      '--quiet',
      '-b',
      'feature',
      'origin/main'
    );
    await Bun.write(
      path.join(fx.work, 'assets/blob.bin'),
      new Uint8Array([0, 1, 2, ...new TextEncoder().encode('Globex'), 0, 255])
    );
    await fx.git(fx.work, 'add', 'assets/blob.bin');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: add blob');

    await expectRefused('feature', 'file assets/blob.bin', 'Globex');
  });

  test('a deny term in a file name or the branch name is refused', async () => {
    await denyList(['globex']);
    await commitFeature({ 'docs/globex-notes.md': 'notes\n' });

    await expectRefused('feature', 'file name docs/globex-notes.md', 'globex');

    await fx.git(fx.work, 'checkout', '--quiet', 'main');
    await commitFeature(
      { 'src/feature.txt': 'feature\n' },
      'feat: feature work',
      'globex-fix'
    );
    await expectRefused('globex-fix', 'the branch name', 'globex');
  });

  test('the PR title is refused before anything is pushed', async () => {
    await denyList(['globex']);
    await cutFeatureBranch('origin/main');
    await mkdir(path.join(fx.work, 'acme'));
    for (const [name, target] of [
      ['upstream', fx.upstream],
      ['public', fx.publicFork ?? ''],
    ] as const) {
      await symlink(target, path.join(fx.work, 'acme', name));
      await fx.git(fx.work, 'remote', 'set-url', name, `acme/${name}`);
    }
    await appendFile(path.join(fx.work, '.git', 'info', 'exclude'), 'acme/\n');
    const gh = await githubMirror(fx);
    await gh.setRoutes([
      {
        match: `pr list --repo ${MIRROR_REPO} --head feature --state open`,
        stdout: JSON.stringify([]),
      },
    ]);

    const error = await stageCommand('feature', {
      dryRun: true,
      createPr: true,
      title: 'feat: Globex feature',
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({
      cause: {
        code: 'mirror-reference',
        details: { where: 'the upstream PR title', matched: 'globex' },
      },
    });
  });

  test('an invalid denyTerms entry refuses stage', async () => {
    await denyList(['ok', '']);
    await commitFeature({ 'src/feature.txt': 'feature\n' });

    await expect(stageCommand('feature')).rejects.toMatchObject({
      cause: { code: 'config' },
    });
    const checks = await runDoctorChecks({ cwd: fx.work });
    expect(checks.find((check) => check.id === 'repo')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('denyTerms must be a list'),
    });
  });
});

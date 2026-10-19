import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { ON_STDERR, quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import {
  type ApprovalScenario,
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
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fx.cleanup();
});

async function setApproval(level: string | undefined): Promise<void> {
  const config = await fx.readRawConfig();
  if (level === undefined) delete config.approval;
  else config.approval = level;
  await fx.writeRawConfig(JSON.stringify(config, null, 2));
}

/** Commits on a feature branch and pushes it to origin, as a PR head. */
async function pushFeature(): Promise<string> {
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature', 'origin/main');
  await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
  await fx.git(fx.work, 'add', 'src/feature.txt');
  await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: feature work');
  await fx.git(fx.work, 'push', '--quiet', 'origin', 'feature');
  return fx.sha(fx.work, 'feature');
}

async function scenario(
  overrides: Partial<ApprovalScenario> & { headSha: string }
): Promise<void> {
  await gh.setRoutes(approvalRoutes({ branch: 'feature', ...overrides }));
}

const publicFeature = async () =>
  fx
    .git(
      fx.publicFork ?? '',
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/feature'
    )
    .catch(() => null);

const errorLines = () =>
  (prompts.log.error as ReturnType<typeof mock>).mock.calls.map((c) =>
    String(c[0])
  );

describe('the approval gate in stage', () => {
  test('with approval off, stage reads no review and calls no gh', async () => {
    await pushFeature();

    const result = await stageCommand('feature', {
      prompt: { yes: true, noInput: true },
    });

    expect(result).not.toHaveProperty('approval');
    expect(await gh.calls()).toEqual([]);
  });

  test('reviewed: an approval on the head from a writer stages exactly that head', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      reviews: [{ login: 'alice', state: 'APPROVED' }],
      checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });

    const result = await stageCommand('feature', {
      prompt: { yes: true, noInput: true },
    });

    expect(result).toMatchObject({
      approval: {
        level: 'reviewed',
        ok: true,
        approvers: ['alice'],
        headSha: head,
      },
    });
    expect(
      await fx.git(fx.publicFork ?? '', 'rev-parse', 'feature^{tree}')
    ).toBe(await fx.git(fx.work, 'rev-parse', `${head}^{tree}`));
  });

  test('nothing about the approval reaches the public fork: the published message is the mirror message', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await scenario({
      headSha: head,
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });

    await stageCommand('feature', { prompt: { yes: true, noInput: true } });

    const published = await fx.git(
      fx.publicFork ?? '',
      'log',
      '--format=%B%an%cn',
      'main..feature'
    );
    expect(published).toBe(
      await fx.git(fx.work, 'log', '--format=%B%an%cn', 'origin/main..feature')
    );
    expect(published).not.toMatch(/alice|approv|stager|pull\/7/i);
    expect((await gh.calls()).every((call) => call.startsWith('api '))).toBe(
      true
    );
    expect(
      (await gh.calls()).some((call) => /--method|-X|POST/.test(call))
    ).toBe(false);
  });

  test('two-person: an approval only from the person staging is refused with the switch hint', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await scenario({
      headSha: head,
      stager: 'solo',
      reviews: [{ login: 'solo', state: 'APPROVED' }],
    });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain(
      'two-person approval needs a reviewer other than you (solo)'
    );
    expect(errorLines().join('\n')).toContain(
      'venfork stage approval reviewed'
    );
    expect(await publicFeature()).toBeNull();
  });

  test('reviewed: the same self-approval counts', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      stager: 'solo',
      reviews: [{ login: 'solo', state: 'APPROVED' }],
    });

    await stageCommand('feature', { prompt: { yes: true, noInput: true } });

    expect(await publicFeature()).not.toBeNull();
  });

  test('a later CHANGES_REQUESTED from the same reviewer overrides the approval', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      reviews: [
        { login: 'alice', state: 'APPROVED' },
        { login: 'alice', state: 'CHANGES_REQUESTED' },
      ],
    });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain('alice requested changes');
    expect(await publicFeature()).toBeNull();
  });

  test('an approval of an older commit, a dismissed approval and a bot approval do not count', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      reviews: [
        { login: 'alice', state: 'APPROVED', commitId: 'a'.repeat(40) },
        { login: 'bob', state: 'DISMISSED' },
        { login: 'ci-helper[bot]', state: 'APPROVED', type: 'Bot' },
      ],
    });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain('is for an older commit');
    expect(await publicFeature()).toBeNull();
  });

  test('a reviewer with read access does not count', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      reviews: [{ login: 'reader', state: 'APPROVED' }],
      permissions: { reader: 'read' },
    });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain(
      'has no approving review that counts'
    );
  });

  test('a pending or failed check blocks', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    for (const [checkRuns, statuses, text] of [
      [[{ name: 'ci', status: 'in_progress' }], [], 'still running on'],
      [[], [{ context: 'lint', state: 'failure' }], 'failed on'],
    ] as const) {
      await scenario({
        headSha: head,
        reviews: [{ login: 'alice', state: 'APPROVED' }],
        checkRuns: [...checkRuns],
        statuses: [...statuses],
      });
      await expect(
        stageCommand('feature', { prompt: { yes: true, noInput: true } })
      ).rejects.toThrow(new CommandExitError(1));
      expect(errorLines().join('\n')).toContain(text);
    }
    expect(await publicFeature()).toBeNull();
  });

  test('a local branch that moved past the approved head is refused', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });
    await Bun.write(`${fx.work}/src/later.txt`, 'later\n');
    await fx.git(fx.work, 'add', 'src/later.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: unreviewed work');

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain('but the approved PR head is');
    expect(await publicFeature()).toBeNull();
  });

  test('no open mirror PR is refused with the open-a-PR and switch hint', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await scenario({ headSha: head, noPr: true });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    const text = errorLines().join('\n');
    expect(text).toContain("'feature' has no open PR on acme/project-private");
    expect(text).toContain('venfork stage approval reviewed');
  });

  test('--dry-run reports a refusal, pushes nothing and returns', async () => {
    const head = await pushFeature();
    await setApproval('two-person');
    await scenario({ headSha: head, reviews: [] });

    const result = await stageCommand('feature', { dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      approval: { level: 'two-person', ok: false, reason: 'not-approved' },
    });
    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('A real stage would be refused'),
      ON_STDERR
    );
    expect(await publicFeature()).toBeNull();
  });

  test('an approval level from a newer venfork refuses instead of staging', async () => {
    await pushFeature();
    await setApproval('three-person');

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain(
      'is not supported by this venfork version'
    );
    expect(await publicFeature()).toBeNull();
  });
});

describe('which mirror PR the approval gate reads', () => {
  /** Commits on a `wip` branch and pushes it, then branches `feature` off it. */
  async function pushStackedFeature(): Promise<string> {
    await fx.git(fx.work, 'checkout', '--quiet', '-b', 'wip', 'origin/main');
    await Bun.write(`${fx.work}/src/unreviewed.txt`, 'never reviewed\n');
    await fx.git(fx.work, 'add', 'src/unreviewed.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: unreviewed base');
    await fx.git(fx.work, 'push', '--quiet', 'origin', 'wip');
    await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature');
    await Bun.write(`${fx.work}/src/feature.txt`, 'feature\n');
    await fx.git(fx.work, 'add', 'src/feature.txt');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: reviewed change');
    await fx.git(fx.work, 'push', '--quiet', 'origin', 'feature');
    return fx.sha(fx.work, 'feature');
  }

  test('a PR stacked on another branch is refused with wrong-base, so the base commits do not ship', async () => {
    const head = await pushStackedFeature();
    await setApproval('two-person');
    await scenario({
      headSha: head,
      baseRef: 'wip',
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain(
      "targets 'wip', not the mirror default branch 'main'"
    );
    expect(await publicFeature()).toBeNull();
    const dry = await stageCommand('feature', { dryRun: true });
    expect(dry).toMatchObject({
      approval: { ok: false, reason: 'wrong-base' },
    });
  });

  test('with several open PRs for the branch, the gate reads the one based on the default branch', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      prNumber: 8,
      baseRef: 'main',
      extraPrs: [{ number: 9, baseRef: 'wip' }],
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });

    const result = await stageCommand('feature', {
      prompt: { yes: true, noInput: true },
    });

    expect(result).toMatchObject({
      approval: {
        ok: true,
        prUrl: 'https://github.com/acme/project-private/pull/8',
      },
    });
  });

  test('two open PRs for the branch on the default branch are refused and name --internal-pr', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      prNumber: 8,
      extraPrs: [{ number: 9 }],
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    const text = errorLines().join('\n');
    expect(text).toContain('#8, #9');
    expect(text).toContain('--internal-pr <n>');
    expect(await publicFeature()).toBeNull();
    expect(await stageCommand('feature', { dryRun: true })).toMatchObject({
      approval: { ok: false, reason: 'ambiguous-pr' },
    });
  });

  test('--internal-pr naming a PR on another branch names both branches', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      prNumber: 12,
      headRef: 'other',
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });

    await expect(
      stageCommand('feature', {
        internalPrNumber: 12,
        prompt: { yes: true, noInput: true },
      })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain(
      "PR #12 on acme/project-private is for 'other', not 'feature'"
    );
  });

  test('--internal-pr naming a PR whose head is in a fork is refused', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      prNumber: 12,
      headRepo: 'mallory/project-private',
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });

    await expect(
      stageCommand('feature', {
        internalPrNumber: 12,
        prompt: { yes: true, noInput: true },
      })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain(
      'its head is in mallory/project-private'
    );
    expect(await publicFeature()).toBeNull();
  });
});

describe('approval gate reads through gh', () => {
  test('reviewed: an App token that cannot read /user still stages', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      stagerFails: true,
      reviews: [{ login: 'alice', state: 'APPROVED' }],
    });

    await stageCommand('feature', { prompt: { yes: true, noInput: true } });

    expect(await publicFeature()).not.toBeNull();
    expect((await gh.calls()).some((call) => call === 'api user')).toBe(false);
  });

  test('gh on a TTY (GH_FORCE_TTY) still gives one JSON value per line', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      reviews: [{ login: 'alice', state: 'APPROVED' }],
      checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      statuses: [{ context: 'lint', state: 'success' }],
    });
    process.env.GH_FORCE_TTY = '1';
    try {
      await stageCommand('feature', { prompt: { yes: true, noInput: true } });
    } finally {
      delete process.env.GH_FORCE_TTY;
    }

    expect(await publicFeature()).not.toBeNull();
  });

  test('a failed commit status past the first page of statuses blocks', async () => {
    const head = await pushFeature();
    await setApproval('reviewed');
    await scenario({
      headSha: head,
      reviews: [{ login: 'alice', state: 'APPROVED' }],
      statusPages: [
        [{ context: 'lint', state: 'success' }],
        [{ context: 'deploy', state: 'failure' }],
      ],
    });

    await expect(
      stageCommand('feature', { prompt: { yes: true, noInput: true } })
    ).rejects.toThrow(new CommandExitError(1));

    expect(errorLines().join('\n')).toContain('failed on');
    expect(errorLines().join('\n')).toContain('deploy');
    expect(await publicFeature()).toBeNull();
  });
});

describe('the upstream PR body under the approval gate', () => {
  test('comes from the approved mirror PR, not another PR for the same branch name', async () => {
    gh = await githubMirror(fx, { allRemotes: true });
    const head = await pushFeature();
    await setApproval('reviewed');
    const approved = {
      number: 7,
      url: 'https://github.com/acme/project-private/pull/7',
      title: 'Approved change',
      body: 'Body of the approved PR.',
    };
    const other = {
      number: 30,
      url: 'https://github.com/acme/project-private/pull/30',
      title: 'Other PR',
      body: 'Body of another PR.',
    };
    await gh.setRoutes([
      { match: 'pr view 7 ', stdout: JSON.stringify(approved) },
      { match: 'pr list', stdout: JSON.stringify([other]) },
      ...approvalRoutes({
        branch: 'feature',
        headSha: head,
        reviews: [{ login: 'alice', state: 'APPROVED' }],
      }),
    ]);

    const result = await stageCommand('feature', {
      createPr: true,
      dryRun: true,
    });

    expect(result).toMatchObject({
      approval: { ok: true },
      internalPrUrl: approved.url,
      prBody: 'Body of the approved PR.',
    });
  });
});

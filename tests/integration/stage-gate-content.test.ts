import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand, syncCommand } from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import {
  assertNoMirrorReference,
  mirrorDenyList,
} from '../../src/shared/deny-list.js';
import {
  assertPublishableCommits,
  collectMirrorBlobs,
  type MirrorText,
} from '../../src/shared/stage-gate.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';
import { seedPreserve } from '../harness/preserve.js';

let fx: MirrorFixture;
const originalCwd = process.cwd();

beforeEach(async () => {
  fx = await createMirrorFixture();
  process.chdir(fx.work);
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env.VENFORK_ALLOW_SELF_REFERENCE;
  await fx.cleanup();
});

const git = (...args: string[]) => fx.git(fx.work, ...args);

async function featureFromUpstream(): Promise<void> {
  await git('fetch', '--quiet', 'upstream');
  await git('checkout', '--quiet', '-b', 'feature', 'upstream/main');
}

async function commitFile(
  file: string,
  content: string | Buffer,
  message: string,
  gitArgs: string[] = []
): Promise<void> {
  await Bun.write(`${fx.work}/${file}`, content);
  await git('add', '--', file);
  await git('commit', '--quiet', '-m', message, ...gitArgs);
}

interface GateOptions {
  denyList?: readonly string[];
  mirrorBlobs?: ReadonlyMap<string, string>;
  mirrorTexts?: readonly MirrorText[];
  preserve?: readonly string[];
  gitArgs?: string[];
}

/** Commits `file` on a feature branch off upstream and runs the gate on it. */
async function gate(
  file: string,
  content: string | Buffer,
  message = 'feat: x',
  options: GateOptions = {}
): Promise<string[]> {
  await featureFromUpstream();
  await commitFile(file, content, message, options.gitArgs);
  return runGate(options);
}

function runGate(options: GateOptions = {}): Promise<string[]> {
  return assertPublishableCommits({
    branch: 'feature',
    base: 'upstream/main',
    head: 'feature',
    preserve: options.preserve ?? [],
    mirrorBlobs: options.mirrorBlobs ?? new Map(),
    mirrorTexts: options.mirrorTexts ?? [],
    denyList: options.denyList ?? [],
    recordedUrls: [],
    originalOf: new Map(),
    cwd: fx.work,
  });
}

const MARKED =
  'Fix parser <!-- venfork:internal -->for client ACME, invoice 42<!-- /venfork:internal -->\n';

describe('internal markers never ship in published text', () => {
  test('a file holding a marker pair is refused', async () => {
    await expect(gate('CHANGELOG.md', MARKED, 'docs: log')).rejects.toThrow(
      /commit \w+ file CHANGELOG\.md contains/
    );
  });

  test('a marker disguised with zero-width characters is refused', async () => {
    await expect(
      gate('CHANGELOG.md', 'x venfork\u200b:\u00a0internal y\n', 'docs: log')
    ).rejects.toThrow('contains');
  });

  test('a marker in a UTF-16 file is refused', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(MARKED, 'utf16le'),
    ]);
    await expect(gate('CHANGELOG.md', bytes, 'docs: log')).rejects.toThrow(
      'contains'
    );
  });

  test('a message holding a marker pair is refused under self-reference', async () => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
    await expect(
      gate('src/a.txt', 'a\n', `fix: parser\n\n${MARKED}`)
    ).rejects.toThrow(/commit \w+ message contains/);
  });

  test('an author name shaped like a marker is refused under self-reference', async () => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
    await expect(
      gate('src/a.txt', 'a\n', 'feat: a', {
        gitArgs: ['--author', 'venfork:internal <a@example.com>'],
      })
    ).rejects.toThrow(/commit \w+ author name contains/);
  });

  test('a file and a message that only name the tool ship under self-reference', async () => {
    process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
    expect(
      await gate('docs/a.md', 'We use venfork for mirrors.\n', 'docs: venfork')
    ).toEqual(['docs/a.md']);
  });
});

const DOC = 'docs/internal.md';
const ROADMAP = [
  'Client ACME wants the billing export by March',
  'Invoice numbers follow the ACME-2024 scheme',
  'Do not mention the migration to the public repo',
  'Escalation contact is the account manager',
  'Budget approved for two additional engineers',
  'Short line',
].join('\n');

/** Preserves DOC on the mirror, syncs it, and returns what the gate reads. */
async function mirrorWithRoadmap(): Promise<GateOptions> {
  await fx.commitOnOrigin({ [DOC]: `${ROADMAP}\n` }, 'docs: notes');
  await seedPreserve(fx, [DOC]);
  await syncCommand(undefined, { cwd: fx.work, quiet: true });
  await git('fetch', '--quiet', 'origin');
  const scan = await collectMirrorBlobs(
    ['refs/remotes/origin/main', 'refs/heads/main'],
    [DOC],
    'upstream/main',
    fx.work
  );
  return {
    mirrorBlobs: scan.blobs,
    mirrorTexts: scan.texts,
    preserve: [DOC],
  };
}

describe('preserved text is refused when a copy only differs in form', () => {
  const lines = ROADMAP.split('\n');
  const variants: Array<[string, () => string | Buffer]> = [
    ['one letter changed', () => `${ROADMAP.replace('March', 'Marsh')}\n`],
    ['a line prepended', () => `# Notes\n${ROADMAP}\n`],
    ['a line removed', () => `${lines.slice(1).join('\n')}\n`],
    ['CRLF line endings', () => `${ROADMAP.replaceAll('\n', '\r\n')}\r\n`],
    ['trailing whitespace', () => `${lines.map((l) => `${l}  `).join('\n')}\n`],
    ['a UTF-8 byte order mark', () => `﻿${ROADMAP}\n`],
    [
      'UTF-16LE with a byte order mark',
      () =>
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(`${ROADMAP}\n`, 'utf16le'),
        ]),
    ],
  ];

  test.each(variants)('%s', async (_label, build) => {
    const options = await mirrorWithRoadmap();
    await expect(
      gate('docs/copy.md', build(), 'docs: copy', options)
    ).rejects.toThrow(/docs\/copy\.md \(near copy of docs\/internal\.md\)/);
  });

  test('a copy of upstream text that the preserved file also carries ships', async () => {
    await fx.commitOnUpstream({ 'NOTES.md': `${ROADMAP}\n` });
    await syncCommand(undefined, { cwd: fx.work, quiet: true });
    await fx.commitOnOrigin(
      { 'NOTES.md': `${ROADMAP}\nPrivate addendum for the client team\n` },
      'docs: addendum'
    );
    await git('fetch', '--quiet', 'origin');
    const scan = await collectMirrorBlobs(
      ['refs/remotes/origin/main', 'refs/heads/main'],
      ['NOTES.md'],
      'upstream/main',
      fx.work
    );

    expect(
      await gate('docs/copy.md', `${ROADMAP}\n`, 'docs: copy', {
        mirrorBlobs: scan.blobs,
        mirrorTexts: scan.texts,
        preserve: ['NOTES.md'],
      })
    ).toEqual(['docs/copy.md']);
  });

  test('a file sharing two short lines with the preserved file ships', async () => {
    const options = await mirrorWithRoadmap();
    expect(
      await gate(
        'docs/other.md',
        'Short line\nBudget approved for two additional engineers\nunrelated text here\n',
        'docs: other',
        options
      )
    ).toEqual(['docs/other.md']);
  });
});

/** The deny list `mirrorDenyList` builds for a checkout with these remotes. */
async function denyListFor(
  origin: string,
  upstream: string
): Promise<string[]> {
  const dir = `${fx.root}/deny-${Math.random().toString(36).slice(2)}`;
  await $`git init --quiet ${dir}`;
  await $({ cwd: dir })`git remote add origin ${origin}`;
  await $({ cwd: dir })`git remote add upstream ${upstream}`;
  return mirrorDenyList(dir);
}

describe.each([
  [
    'github.com',
    'git@github.com:acme/widget-private.git',
    'acme/widget-private',
  ],
  [
    'a GitHub Enterprise host',
    'git@github.acme.com:team/widget-private.git',
    'team/widget-private',
  ],
])(
  'the mirror name is refused in text bound for upstream (%s)',
  (_label, origin, ownerName) => {
    let denyList: string[];

    beforeEach(async () => {
      denyList = await denyListFor(origin, 'git@github.com:other/widget.git');
    });

    test.each([
      ['a bare name', 'Ported from widget-private after review.'],
      ['a name with an issue number', 'see widget-private#12'],
      ['owner/name with an issue number', `see ${ownerName}#3`],
    ])('a PR body with %s', (_what, body) => {
      expect(() =>
        assertNoMirrorReference(body, 'the upstream PR body', denyList)
      ).toThrow('widget-private');
    });

    test('a commit message with a bare name', async () => {
      await expect(
        gate('src/a.txt', 'a\n', 'fix: port from widget-private', { denyList })
      ).rejects.toThrow(/commit \w+ message contains/);
    });

    test('file content that names a package of the same name ships', async () => {
      expect(
        await gate(
          'src/a.ts',
          'import x from "acme-ui/widget-private";\n',
          'x',
          {
            denyList,
          }
        )
      ).toEqual(['src/a.ts']);
    });
  }
);

describe('deny-list gaps that published end to end', () => {
  let denyList: string[];

  beforeEach(async () => {
    denyList = await denyListFor(
      'git@github.com:acme/widget-private.git',
      'git@github.com:other/widget.git'
    );
  });

  test.each([
    [
      'a percent-encoded login redirect',
      'https://github.com/login?return_to=%2Facme%2Fwidget-private%2Fpull%2F5',
    ],
    ['a percent-encoded owner/name', 'acme%2Fwidget-private'],
    ['a double-encoded owner/name', 'acme%252Fwidget-private'],
    ['a GitHub Pages URL', 'https://acme.github.io/widget-private/'],
  ])('a PR body with %s', (_what, body) => {
    expect(() =>
      assertNoMirrorReference(body, 'the upstream PR body', denyList)
    ).toThrow('contains');
  });

  test('a commit message with a GitHub Pages URL', async () => {
    await expect(
      gate(
        'src/a.txt',
        'a\n',
        'docs: see https://acme.github.io/widget-private/',
        {
          denyList,
        }
      )
    ).rejects.toThrow(/commit \w+ message contains/);
  });

  test('a file with a GitHub Pages URL', async () => {
    await expect(
      gate(
        'docs/a.md',
        'docs at https://acme.github.io/widget-private/\n',
        'x',
        {
          denyList,
        }
      )
    ).rejects.toThrow(/file docs\/a\.md contains/);
  });

  test('malformed percent sequences do not throw', () => {
    expect(() =>
      assertNoMirrorReference('100%zz and %E0%A4%A', 'the PR body', denyList)
    ).not.toThrow();
  });
});

describe('a branch name that runs on from the mirror name', () => {
  test.each([
    'fix/widget-private-sync',
    'widget-private-staging',
    'widget-private_notes',
  ])('%p is refused before any push', async (branch) => {
    await git(
      'remote',
      'set-url',
      'origin',
      'git@git.example.invalid:acme/widget-private.git'
    );
    await featureFromUpstream();
    await git('branch', '--quiet', '-m', branch);

    await expect(stageCommand(branch)).rejects.toThrow(new CommandExitError(1));

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining("the branch name contains 'widget-private'")
    );
    expect(
      await fx.git(fx.publicFork ?? '', 'for-each-ref', 'refs/heads')
    ).not.toContain(branch);
  });
});

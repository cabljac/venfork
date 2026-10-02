import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { seedPreserve } from '../harness/preserve.js';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import { stageCommand, syncCommand } from '../../src/commands.js';
import {
  assertPublishableCommits,
  collectMirrorBlobs,
} from '../../src/shared/stage-gate.js';
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
  delete process.env.VENFORK_ALLOW_SELF_REFERENCE;
  await fx.cleanup();
});

const git = (...args: string[]) => fx.git(fx.work, ...args);
const sync = () => syncCommand(undefined, { cwd: fx.work, quiet: true });

async function featureFrom(base: string): Promise<void> {
  await git('fetch', '--quiet', 'origin');
  await git('fetch', '--quiet', 'upstream');
  await git('checkout', '--quiet', '-b', 'feature', base);
}

async function commitFile(
  file: string,
  content: string | Buffer,
  message: string
): Promise<void> {
  await Bun.write(`${fx.work}/${file}`, content);
  await git('add', '--', file);
  await git('commit', '--quiet', '-m', message);
}

async function published(): Promise<boolean> {
  const result = await $({
    cwd: fx.publicFork ?? '',
    reject: false,
  })`git rev-parse --verify --quiet refs/heads/feature`;
  return result.exitCode === 0;
}

async function expectRefused(...messages: string[]): Promise<void> {
  await expect(stageCommand('feature')).rejects.toThrow('process.exit(1)');
  for (const message of messages) {
    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(message)
    );
  }
  expect(await published()).toBe(false);
}

async function expectShipped(): Promise<void> {
  await stageCommand('feature');
  expect(await published()).toBe(true);
}

function warnings(): string[] {
  return (
    prompts.log.warn as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.map((call) => String(call[0]));
}

/** Moves `ref` through `count` new commits on its tree, then back, as reflog entries. */
async function growReflog(ref: string, count: number): Promise<void> {
  const tip = await git('rev-parse', ref);
  const tree = await git('rev-parse', `${tip}^{tree}`);
  let parent = tip;
  for (let i = 0; i < count; i++) {
    parent = await git('commit-tree', tree, '-p', parent, '-m', `x${i}`);
    await git('update-ref', ref, parent);
  }
  await git('update-ref', ref, tip);
}

/**
 * Moves `ref` through `count` new commits that each give every file in
 * `files` new content, then back to its tip, so only the reflog holds them.
 */
async function growReflogWithVersions(
  ref: string,
  files: readonly string[],
  count: number
): Promise<void> {
  const tip = await git('rev-parse', ref);
  let script = '';
  for (let i = 0; i < count; i++) {
    const message = `v${i}`;
    script += `commit refs/tmp/versions\nmark :${i + 1}\ncommitter t <t@t> ${1700000000 + i} +0000\ndata ${message.length}\n${message}\n`;
    script += `from ${i === 0 ? tip : `:${i}`}\n`;
    for (const file of files) {
      const body = `${file} version ${i}\n`;
      script += `M 100644 inline ${file}\ndata ${body.length}\n${body}`;
    }
    script += '\n';
  }
  const marks = `${fx.root}/versions.marks`;
  await $({
    cwd: fx.work,
    input: script,
  })`git fast-import --quiet --export-marks=${marks}`;
  const shas = (await Bun.file(marks).text())
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[1] ?? '');
  await git('update-ref', '-d', 'refs/tmp/versions');
  const reflog = `${fx.work}/.git/logs/${ref}`;
  let entries = '';
  let previous = tip;
  for (const sha of [...shas, tip]) {
    entries += `${previous} ${sha} t <t@t> 1700000000 +0000\tfetch\n`;
    previous = sha;
  }
  await Bun.write(reflog, (await Bun.file(reflog).text()) + entries);
}

describe('collectMirrorBlobs scales with history', () => {
  test('reads 10 preserved files across 300 reflog entries in under 5 s', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`keep/f${i}.txt`] = `kept ${i}\n`;
    await fx.commitOnOrigin(files);
    await seedPreserve(fx, Object.keys(files));
    await sync();
    await git('fetch', '--quiet', 'origin');
    await growReflogWithVersions(
      'refs/remotes/origin/main',
      Object.keys(files),
      300
    );

    const started = Date.now();
    const { blobs } = await collectMirrorBlobs(
      ['refs/remotes/origin/main', 'refs/heads/main'],
      Object.keys(files),
      'upstream/main',
      fx.work
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5000);
    const kept = [...blobs.values()].filter((p) => p.startsWith('keep/'));
    expect(kept.length).toBe(10 * 301);
    expect([...new Set(kept)].sort()).toEqual(Object.keys(files).sort());
  });

  test('refuses when a reflog is over the history cap', async () => {
    await fx.commitOnOrigin({ 'keep/a.txt': 'kept\n' });
    await seedPreserve(fx, ['keep/a.txt']);
    await sync();
    await git('fetch', '--quiet', 'origin');
    await growReflog('refs/remotes/origin/main', 10);

    const scan = collectMirrorBlobs(
      ['refs/remotes/origin/main'],
      ['keep/a.txt'],
      'upstream/main',
      fx.work,
      { historyCap: 3 }
    );

    await expect(scan).rejects.toThrow(
      'refs/remotes/origin/main has more than 3 reflog entries'
    );
    await expect(scan).rejects.toThrow('git reflog expire');
  });

  test('refuses when mirror-only history is over the history cap', async () => {
    let commit = await git('rev-parse', 'upstream/main');
    const tree = await git('rev-parse', `${commit}^{tree}`);
    for (let i = 0; i < 4; i++) {
      commit = await git('commit-tree', tree, '-p', commit, '-m', `m${i}`);
    }

    await expect(
      collectMirrorBlobs([commit], [], 'upstream/main', fx.work, {
        historyCap: 3,
      })
    ).rejects.toThrow('more than 3 commits');
  });

  test('a reflog of exactly the history cap is read in full', async () => {
    await fx.commitOnOrigin({ 'keep/a.txt': 'kept\n' });
    await seedPreserve(fx, ['keep/a.txt']);
    await sync();
    await git('fetch', '--quiet', 'origin');
    await growReflog('refs/remotes/origin/main', 5);
    const entries = (await git('reflog', 'show', 'refs/remotes/origin/main'))
      .split('\n')
      .filter(Boolean).length;
    const scan = (historyCap: number) =>
      collectMirrorBlobs(
        ['refs/remotes/origin/main'],
        ['keep/a.txt'],
        'upstream/main',
        fx.work,
        { historyCap }
      );

    const { blobs } = await scan(entries);

    expect([...blobs.values()]).toContain('keep/a.txt');
    await expect(scan(entries - 1)).rejects.toThrow(
      `more than ${entries - 1} reflog entries`
    );
  });

  test('stage refuses and pushes nothing when origin has more than 20000 reflog entries', async () => {
    const tip = await git('rev-parse', 'refs/remotes/origin/main');
    const reflog = `${fx.work}/.git/logs/refs/remotes/origin/main`;
    const line = `${tip} ${tip} t <t@t> 1700000000 +0000\tfetch\n`;
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', 'feat: a');
    await Bun.write(reflog, line.repeat(20001));

    await expectRefused('more than 20000 reflog entries');
  });

  test('stage does not warn when the reflog of origin/main is empty', async () => {
    await git('reflog', 'expire', '--expire=now', '--all');
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', 'feat: a');

    await expectShipped();

    expect(warnings()).toEqual([]);
  });
});

describe('upstream history is not mirror content', () => {
  test('an old upstream version of a preserved file ships at another path', async () => {
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 80\n' });
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 8080\n' });
    await sync();
    await seedPreserve(fx, ['config/app.yml']);
    await featureFrom('upstream/main');
    await commitFile('examples/app.yml', 'port: 80\n', 'docs: example');

    await expectShipped();
  });

  test('an upstream version an old managed commit preserved ships at another path', async () => {
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 80\n' });
    await fx.commitOnOrigin({ 'keep/x.txt': 'k\n' });
    await seedPreserve(fx, ['config/app.yml', 'keep/x.txt']);
    await sync();
    await git('fetch', '--quiet', 'origin');
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 8080\n' });
    await sync();
    await featureFrom('upstream/main');
    await commitFile('examples/app.yml', 'port: 80\n', 'docs: example');

    await expectShipped();
  });

  test('a mirror-only version of an upstream path copied elsewhere is still refused', async () => {
    await fx.commitOnUpstream({ 'config/app.yml': 'port: 80\n' });
    await sync();
    await fx.commitOnOrigin({ 'config/app.yml': 'port: 9999 secret\n' });
    await seedPreserve(fx, ['config/app.yml']);
    await featureFrom('upstream/main');
    await commitFile('examples/app.yml', 'port: 9999 secret\n', 'docs: x');

    await expectRefused('examples/app.yml (content of config/app.yml)');
  });
});
describe('the gate reads every text encoding', () => {
  test('a UTF-16LE file whose mirror URL is split by zero-width spaces is refused', async () => {
    const hidden = fx.origin.split('').join('\u200b');
    await featureFrom('upstream/main');
    await commitFile(
      'docs/remote.txt',
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`clone ${hidden}\n`, 'utf16le'),
      ]),
      'docs: remote'
    );

    await expectRefused('docs/remote.txt', fx.origin);
  });

  test('a UTF-16BE file whose mirror URL is split by zero-width spaces is refused', async () => {
    const hidden = fx.origin.split('').join('\u200b');
    await featureFrom('upstream/main');
    await commitFile(
      'docs/remote.txt',
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(`clone ${hidden}\n`, 'utf16le').swap16(),
      ]),
      'docs: remote'
    );

    await expectRefused('docs/remote.txt', fx.origin);
  });

  test('a UTF-16LE byte order mark before a UTF-8 mirror URL is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'docs/remote.txt',
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`clone ${fx.origin}\n`),
      ]),
      'docs: remote'
    );

    await expectRefused('docs/remote.txt', fx.origin);
  });

  test('a UTF-16BE byte order mark before a UTF-8 mirror URL is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'docs/remote.txt',
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(`clone ${fx.origin}\n`),
      ]),
      'docs: remote'
    );

    await expectRefused('docs/remote.txt', fx.origin);
  });

  test('a UTF-16LE mirror URL after 8001 ASCII bytes, without a BOM, is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'docs/remote.txt',
      Buffer.concat([
        Buffer.alloc(8001, 0x61),
        Buffer.from(`\nclone ${fx.origin}\n`, 'utf16le'),
      ]),
      'docs: remote'
    );

    await expectRefused('docs/remote.txt', fx.origin);
  });

  test('a UTF-16BE file without a BOM ending in the mirror URL is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'docs/remote.txt',
      Buffer.from(`clone ${fx.origin.toUpperCase()}`, 'utf16le').swap16(),
      'docs: remote'
    );

    await expectRefused('docs/remote.txt', fx.origin);
  });

  test('text after a leading NUL naming the mirror is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile('docs/x.md', `\0\nclone ${fx.origin}\n`, 'docs: x');

    await expectRefused('docs/x.md', fx.origin);
  });

  test('a binary file holding the mirror URL as UTF-16LE is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'bin.dat',
      Buffer.concat([
        Buffer.from([0, 1, 2]),
        Buffer.from(fx.origin, 'utf16le'),
      ]),
      'chore: bin'
    );

    await expectRefused('bin.dat', fx.origin);
  });

  test('a blob over the buffer limit is refused with a message naming it', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'data/big.txt',
      Buffer.alloc(110_000_000, 0x61),
      'data: big'
    );

    await expectRefused('data/big.txt', 'too large to check');
  }, 120000);
});

describe('file content needs a host before the bare mirror name', () => {
  const NAME_TERMS = [
    'git@github.com:acme/widget-private.git',
    'git@github.com:acme/widget-private',
    'acme/widget-private',
    'widget-private',
  ];

  async function gate(file: string, content: string): Promise<string[]> {
    await featureFrom('upstream/main');
    await commitFile(file, content, 'feat: x');
    return assertPublishableCommits({
      branch: 'feature',
      base: 'upstream/main',
      head: 'feature',
      preserve: [],
      mirrorBlobs: new Map(),
      denyList: NAME_TERMS,
      recordedUrls: [],
      originalOf: new Map(),
      cwd: fx.work,
    });
  }

  test('a package path with the mirror name passes', async () => {
    expect(
      await gate('src/a.ts', 'import x from "acme-ui/widget-private";\n')
    ).toEqual(['src/a.ts']);
  });

  test('another owner URL with the mirror name is refused', async () => {
    await expect(
      gate('docs/a.md', 'see https://github.com/other/widget-private/pull/3\n')
    ).rejects.toThrow("contains 'widget-private'");
  });

  test('a file name with another owner and the mirror name is refused', async () => {
    await expect(gate('other/widget-private', 'x\n')).rejects.toThrow(
      "contains 'widget-private'"
    );
  });
});

describe('the config signature', () => {
  const tsSource = (n: number) =>
    `export interface VenforkConfig { upstreamUrl: string; publicForkUrl?: string }\nconst x = { "upstreamUrl": 1, "publicForkUrl": ${n} };\n`;

  test('source code naming the config keys ships', async () => {
    await featureFrom('upstream/main');
    await commitFile('src/config.ts', tsSource(3), 'fix: tweak');

    await expectShipped();
  });

  test('a package-like JSON with only version and upstreamUrl ships', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'fixtures/repo.json',
      '{ "version": "2.0.0", "upstreamUrl": "https://example.com/x" }\n',
      'test: fixture'
    );

    await expectShipped();
  });

  test.each([
    ['mode no-public', '"mode": "no-public"'],
    ['an empty preserve list', '"preserve": []'],
    ['a schedule', '"schedule": { "enabled": false }'],
  ])('upstreamUrl with %s is refused', async (_label, extra) => {
    await featureFrom('upstream/main');
    await commitFile(
      'notes/c.json',
      `{ "upstreamUrl": "git@github.com:a/b.git", ${extra} }\n`,
      'docs: notes'
    );

    await expectRefused('notes/c.json', 'venfork config');
  });

  test('a config.json with other values is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'notes/c.json',
      '{ "version": "1", "upstreamUrl": "git@github.com:a/b.git", "publicForkUrl": "git@github.com:c/b.git" }\n',
      'docs: notes'
    );

    await expectRefused('notes/c.json');
  });

  describe('with self-reference allowed', () => {
    const fixture = {
      version: '1',
      upstreamUrl: 'git@github.com:a/b.git',
      publicForkUrl: 'git@github.com:c/b.git',
    };

    test('a config for another project ships', async () => {
      process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
      await featureFrom('upstream/main');
      await commitFile(
        'fixtures/config.json',
        `${JSON.stringify(fixture)}\n`,
        'test: fixture'
      );

      await expectShipped();
    });

    test('a config with a non-empty link map is refused', async () => {
      process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
      await featureFrom('upstream/main');
      await commitFile(
        'fixtures/config.json',
        JSON.stringify({ ...fixture, pulledPrs: { 'pr-1': { prNumber: 1 } } }),
        'test: fixture'
      );

      await expectRefused('fixtures/config.json', 'venfork config');
    });

    test('this mirror config re-serialised is refused', async () => {
      const config = await fx.readRawConfig();
      process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
      await featureFrom('upstream/main');
      await commitFile(
        'notes/c.json',
        JSON.stringify(config, null, 4),
        'docs: c'
      );

      await expectRefused('notes/c.json', 'venfork config');
    });

    test('this mirror config with a shipped branch is refused', async () => {
      const config = await fx.readRawConfig();
      process.env.VENFORK_ALLOW_SELF_REFERENCE = '1';
      await featureFrom('upstream/main');
      await commitFile(
        'notes/c.json',
        JSON.stringify(
          { ...config, shippedBranches: { 'client-secret': { prNumber: 1 } } },
          null,
          4
        ),
        'docs: c'
      );

      await expectRefused('notes/c.json', 'venfork config');
    });
  });
});
describe('the preview lists every file the history publishes', () => {
  test('a file added then deleted is listed as still in history', async () => {
    await featureFrom('upstream/main');
    await commitFile('notes/plan.md', 'client plan\n', 'wip: add');
    await git('rm', '--quiet', 'notes/plan.md');
    await git('commit', '--quiet', '-m', 'wip: remove');
    await commitFile('src/a.txt', 'a\n', 'feat: a');

    await expectShipped();

    const notes = (prompts.note as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const details = String(notes.find((c) => c[1] === 'Staging Details')?.[0]);
    expect(details).toContain('Files (2) published in history:');
    expect(details).toContain(
      '    - notes/plan.md (removed later in the branch, still in history)'
    );
    expect(details).toContain('    - src/a.txt');
    expect(details).not.toContain('src/a.txt (removed');
  });
});
describe('stage refuses invalid preserve entries', () => {
  test('a trailing-slash entry from an old config is refused with the fix', async () => {
    await fx.commitOnOrigin({ 'docs/x.md': 'client plan\n' });
    const config = await fx.readRawConfig();
    await fx.writeRawConfig(JSON.stringify({ ...config, preserve: ['docs/'] }));
    await featureFrom('upstream/main');
    await commitFile('docs/x.md', 'client plan, edited\n', 'docs: x');

    await expectRefused('venfork preserve remove docs/');
  });
});

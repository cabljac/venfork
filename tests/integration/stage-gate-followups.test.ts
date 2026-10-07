import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as prompts from '@clack/prompts';
import { $ } from 'execa';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import {
  preserveCommand,
  stageCommand,
  syncCommand,
} from '../../src/commands.js';
import { CommandExitError } from '../../src/errors.js';
import { collectMirrorBlobs } from '../../src/shared/stage-gate.js';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';

const DOC = 'docs/a.md';
const DIR = 'docs/internal';
const DIR_FILE = 'docs/internal/x.md';

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

/** Puts `entries` in the config as an old version would have left them. */
async function forcePreserve(entries: string[]): Promise<void> {
  const config = await fx.readRawConfig();
  await fx.writeRawConfig(JSON.stringify({ ...config, preserve: entries }));
}

/**
 * Moves `ref` through `count` new commits that each hold a different
 * `dir/` subtree, then back to its tip, so only the reflog holds them.
 */
async function reflogOfDirectoryVersions(
  ref: string,
  dir: string,
  count: number
): Promise<void> {
  const tip = await fx.git(fx.work, 'rev-parse', ref);
  let script = '';
  for (let i = 0; i < count; i++) {
    const body = `version ${i}\n`;
    script += `commit refs/tmp/dirs\nmark :${i + 1}\ncommitter t <t@t> ${1700000000 + i} +0000\ndata 2\nv\n`;
    script += `from ${i === 0 ? tip : `:${i}`}\n`;
    script += `M 100644 inline ${dir}/f${i % 5}.txt\ndata ${body.length}\n${body}\n`;
  }
  const marks = `${fx.root}/dirs.marks`;
  await $({
    cwd: fx.work,
    input: script,
  })`git fast-import --quiet --export-marks=${marks}`;
  const shas = (await Bun.file(marks).text())
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[1] ?? '');
  await fx.git(fx.work, 'update-ref', '-d', 'refs/tmp/dirs');
  let entries = '';
  let previous = tip;
  for (const sha of [...shas, tip]) {
    entries += `${previous} ${sha} t <t@t> 1700000000 +0000\tfetch\n`;
    previous = sha;
  }
  await Bun.write(`${fx.work}/.git/logs/${ref}`, entries);
}

describe('preserve add verifies each entry is a file on origin', () => {
  test('refuses a directory entry', async () => {
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });

    await expect(preserveCommand('add', [DIR])).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(`Cannot preserve '${DIR}': it is a directory`)
    );
    expect((await fx.readRawConfig()).preserve).toBeUndefined();
  });

  test('refuses a path that is not on the default branch', async () => {
    await expect(preserveCommand('add', [DOC])).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Cannot preserve '${DOC}': it does not exist on origin/main`
      )
    );
  });

  test('refuses a gitlink', async () => {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await fx.git(fx.work, 'checkout', '--quiet', '-b', 'sub', 'origin/main');
    const commit = await fx.git(fx.work, 'rev-parse', 'HEAD');
    await fx.git(
      fx.work,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${commit},vendor/lib`
    );
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'chore: submodule');
    await fx.git(fx.work, 'push', '--quiet', 'origin', 'HEAD:main');

    await expect(preserveCommand('add', ['vendor/lib'])).rejects.toThrow(
      new CommandExitError(1)
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Cannot preserve 'vendor/lib': it is not a file on origin/main"
      )
    );
    expect((await fx.readRawConfig()).preserve).toBeUndefined();
  });

  test('accepts a regular file and an executable', async () => {
    await fx.commitOnOrigin({
      [DOC]: 'notes\n',
      'tools/run.sh': { content: '#!/bin/sh\n', executable: true },
    });

    await preserveCommand('add', [DOC, 'tools/run.sh']);

    expect((await fx.readRawConfig()).preserve).toEqual([DOC, 'tools/run.sh']);
  });
});

describe('a directory entry from an old config is invalid', () => {
  const HINT = `venfork preserve remove '${DIR}'`;

  test('a changed file under the directory is refused with the remove hint', async () => {
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    await forcePreserve([DIR]);
    await featureFrom('upstream/main');
    await commitFile(DIR_FILE, 'something else\n', 'docs: other');

    await expectRefused(HINT);
  });

  test('a copy of a file under the directory at a new path is refused', async () => {
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    await forcePreserve([DIR]);
    await featureFrom('upstream/main');
    await commitFile('notes/copy.md', 'client plan\n', 'docs: copy');

    await expectRefused(HINT);
  });

  test('a teammate commit of the file is refused', async () => {
    await forcePreserve([DIR]);
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    await featureFrom('origin/main');

    await expectRefused(HINT);
  });

  test('sync refuses with the remove hint and leaves origin untouched', async () => {
    await forcePreserve([DIR]);
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    const before = await fx.pushCount(fx.origin, 'refs/heads/main');

    await expect(
      syncCommand(undefined, { cwd: fx.work, quiet: true })
    ).rejects.toThrow(HINT);

    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(before);
  });

  test('a directory with 2000 versions in the reflog is refused in under 2 s', async () => {
    await fx.commitOnOrigin({ 'keep/f0.txt': 'kept\n' });
    await forcePreserve(['keep']);
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await reflogOfDirectoryVersions('refs/remotes/origin/main', 'keep', 2000);
    await featureFrom('upstream/main');
    await commitFile('src/a.txt', 'a\n', 'feat: a');

    const started = Date.now();
    await expectRefused("venfork preserve remove 'keep'");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('collectMirrorBlobs refuses a directory entry without listing it', async () => {
    await fx.commitOnOrigin({ 'keep/f0.txt': 'kept\n' });
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    await reflogOfDirectoryVersions('refs/remotes/origin/main', 'keep', 2000);

    const started = Date.now();
    await expect(
      collectMirrorBlobs(
        ['refs/remotes/origin/main'],
        ['keep'],
        'upstream/main',
        fx.work
      )
    ).rejects.toThrow("venfork preserve remove 'keep'");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the gate matches paths case-insensitively', () => {
  test('a preserved file under another case is refused', async () => {
    await fx.commitOnOrigin({ [DOC]: 'notes\n' });
    await preserveCommand('add', [DOC]);
    await featureFrom('upstream/main');
    await commitFile('docs/A.md', 'edited\n', 'docs: case');

    await expectRefused('mirror-only path(s) docs/A.md');
  });

  test('a .Venfork directory is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile('.Venfork/config.json', '{}\n', 'chore: config');

    await expectRefused('mirror-only path(s) .Venfork/config.json');
  });
});

describe('the gate scans published files for mirror references', () => {
  test('a copied config.json at another path is refused', async () => {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    const config = await fx.git(
      fx.work,
      'show',
      'origin/venfork-config:.venfork/config.json'
    );
    await featureFrom('upstream/main');
    await commitFile('notes/c.json', `${config}\n`, 'docs: notes');

    await expectRefused('notes/c.json');
  });

  test('a config-shaped file with changed values is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(
      'notes/c.json',
      '{ "version": "1", "mode": "x", "upstreamUrl": "https://x/a", "publicForkUrl": "git@x:b" }\n',
      'docs: notes'
    );

    await expectRefused('notes/c.json');
  });

  test('a file containing the mirror URL is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile('docs/remote.md', `clone ${fx.origin}\n`, 'docs: remote');

    await expectRefused(fx.origin);
  });

  test('a file name containing the mirror URL is refused', async () => {
    await featureFrom('upstream/main');
    await commitFile(`x${fx.origin}/f.txt`, 'hello\n', 'docs: path');

    await expectRefused(fx.origin);
  });

  test('a file containing only the word venfork ships', async () => {
    await featureFrom('upstream/main');
    await commitFile('docs/tools.md', 'We sync with venfork.\n', 'docs: tools');

    await expectShipped('docs/tools.md', 'We sync with venfork.\n');
  });

  test('a binary file holding the mirror URL is refused', async () => {
    await featureFrom('upstream/main');
    await Bun.write(
      `${fx.work}/bin.dat`,
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fx.origin)])
    );
    await fx.git(fx.work, 'add', 'bin.dat');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'chore: bin');

    await expectRefused('bin.dat');
  });

  test('a binary file is searched only for URL-derived terms', async () => {
    await featureFrom('upstream/main');
    await Bun.write(
      `${fx.work}/bin.dat`,
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('origin venfork')])
    );
    await fx.git(fx.work, 'add', 'bin.dat');
    await fx.git(fx.work, 'commit', '--quiet', '-m', 'chore: bin');

    await stageCommand('feature');

    expect(await refExists(fx.publicFork ?? '', 'refs/heads/feature')).toBe(
      true
    );
  });
});

describe('collectMirrorBlobs reads history', () => {
  test('every historical version of the config is a mirror blob', async () => {
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');
    const first = await fx.git(
      fx.work,
      'rev-parse',
      'origin/venfork-config:.venfork/config.json'
    );
    await fx.commitOnOrigin({ [DOC]: 'notes\n' });
    await preserveCommand('add', [DOC]);
    await fx.git(fx.work, 'fetch', '--quiet', 'origin');

    const { blobs } = await collectMirrorBlobs(
      ['refs/remotes/origin/main'],
      [],
      'upstream/main',
      fx.work
    );

    expect(blobs.get(first)).toBe('.venfork/config.json');
  });

  test('an older version of a preserved file copied to a new path is refused', async () => {
    await fx.commitOnOrigin({ [DOC]: 'v1 secret\n' });
    await preserveCommand('add', [DOC]);
    await fx.commitOnOrigin({ [DOC]: 'v2 secret\n' });
    await featureFrom('upstream/main');
    await commitFile('docs/b.md', 'v1 secret\n', 'docs: b');

    await expectRefused('docs/b.md');
  });
});

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
  await expect(stageCommand('feature')).rejects.toThrow('process.exit(1)');
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

describe('preserve add verifies each entry is a file on origin', () => {
  test('refuses a directory entry', async () => {
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });

    await expect(preserveCommand('add', [DIR])).rejects.toThrow(
      'process.exit(1)'
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(`Cannot preserve '${DIR}': it is a directory`)
    );
    expect((await fx.readRawConfig()).preserve).toBeUndefined();
  });

  test('refuses a path that is not on the default branch', async () => {
    await expect(preserveCommand('add', [DOC])).rejects.toThrow(
      'process.exit(1)'
    );

    expect(prompts.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Cannot preserve '${DOC}': it does not exist on origin/main`
      )
    );
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

describe('a directory entry from an old config fails closed', () => {
  test('a changed file under the directory is refused', async () => {
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    await forcePreserve([DIR]);
    await featureFrom('upstream/main');
    await commitFile(DIR_FILE, 'something else\n', 'docs: other');

    await expectRefused(`mirror-only path(s) ${DIR_FILE}`);
  });

  test('a copy of a file under the directory at a new path is refused', async () => {
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    await forcePreserve([DIR]);
    await featureFrom('upstream/main');
    await commitFile('notes/copy.md', 'client plan\n', 'docs: copy');

    await expectRefused('notes/copy.md');
  });

  test('a teammate commit of the file is refused', async () => {
    await forcePreserve([DIR]);
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    await featureFrom('origin/main');

    await expectRefused(`mirror-only path(s) ${DIR_FILE}`);
  });

  test('sync aborts and leaves origin untouched', async () => {
    await forcePreserve([DIR]);
    await fx.commitOnOrigin({ [DIR_FILE]: 'client plan\n' });
    const before = await fx.pushCount(fx.origin, 'refs/heads/main');

    await expect(
      syncCommand(undefined, { cwd: fx.work, quiet: true })
    ).rejects.toThrow('Sync aborted to prevent data loss');

    expect(await fx.pushCount(fx.origin, 'refs/heads/main')).toBe(before);
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
      '{ "mode": "x", "upstreamUrl": "a", "publicForkUrl": "b" }\n',
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

  test('a binary file is not scanned', async () => {
    await featureFrom('upstream/main');
    await Bun.write(
      `${fx.work}/bin.dat`,
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fx.origin)])
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

    const blobs = await collectMirrorBlobs(
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

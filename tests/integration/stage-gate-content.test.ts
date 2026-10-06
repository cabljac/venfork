import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assertPublishableCommits } from '../../src/shared/stage-gate.js';
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

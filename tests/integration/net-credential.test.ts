import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { ghRepoIsForkOf } from '../../src/git.js';
import { netExec } from '../../src/shared/net.js';
import { isolateGitEnv } from '../harness/env.js';

let tmp: string;
let bin: string;
/** A PATH entry holding only git, so gh cannot be found. */
let gitOnly: string;
let marker: string;
let globalConfig: string;
let restoreEnv: (() => void) | undefined;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'venfork-net-cred-'));
  bin = path.join(tmp, 'bin');
  marker = path.join(tmp, 'gh-called');
  globalConfig = path.join(tmp, 'gitconfig');
  await mkdir(bin);
  gitOnly = path.join(tmp, 'git-only');
  await mkdir(gitOnly);
  const git = (await $`which git`).stdout.trim();
  await symlink(git, path.join(gitOnly, 'git'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  restoreEnv?.();
  restoreEnv = undefined;
  await rm(marker, { force: true });
});

/** Installs a stub `gh` that records each call, then runs `body`. */
async function useGh(body: string, userConfig = ''): Promise<void> {
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/bin/sh\necho "$*" >> '${marker}'\n${body}\n`);
  await chmod(gh, 0o755);
  await writeFile(globalConfig, userConfig);
  restoreEnv = isolateGitEnv({
    HOME: tmp,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  });
}

/** Asks git for a credential the way a fetch or push to `host` would. */
function fill(host: string) {
  return netExec(undefined, {
    bufferOutput: true,
    input: `protocol=https\nhost=${host}\n\n`,
  })`git credential fill`;
}

describe('netExec gh credential helper', () => {
  test('a failing gh fails closed and fast, with no prompt', async () => {
    await useGh('echo "not logged in" >&2\nexit 1');
    const started = Date.now();

    const result = await fill('github.com');

    expect(result.exitCode).not.toBe(0);
    expect(String(result.stderr)).toContain('terminal prompts disabled');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(marker)).toBe(true);
  });

  test('a missing gh fails closed and fast', async () => {
    await useGh('exit 0');
    process.env.PATH = gitOnly;
    const started = Date.now();

    const result = await fill('github.com');

    expect(result.exitCode).not.toBe(0);
    expect(String(result.stderr)).toContain('terminal prompts disabled');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(marker)).toBe(false);
  });

  test('gh answers for github.com when no other helper does', async () => {
    await useGh('echo username=x-access-token\necho password=gh-token');

    const result = await fill('github.com');

    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain('password=gh-token');
    expect(await Bun.file(marker).text()).toBe('auth git-credential get\n');
  });

  test("gh is the only github.com helper: the user's own helper is not asked", async () => {
    await useGh(
      'echo username=x-access-token\necho password=gh-token',
      '[credential]\n\thelper = "!f() { echo username=me; echo password=user-token; }; f"\n'
    );

    const result = await fill('github.com');

    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain('password=gh-token');
    expect(await Bun.file(marker).text()).toBe('auth git-credential get\n');
  });

  test("a gh-supplied token is not stored in the user's credential helper", async () => {
    const helperLog = path.join(tmp, 'user-helper.log');
    await rm(helperLog, { force: true });
    await useGh(
      'echo username=x-access-token\necho password=gh-token',
      `[credential]\n\thelper = "!f() { echo \\"$1\\" >> '${helperLog}'; cat >/dev/null; }; f"\n`
    );

    const filled = await fill('github.com');
    expect(filled.exitCode).toBe(0);
    const approved = await netExec(undefined, {
      bufferOutput: true,
      input:
        'protocol=https\nhost=github.com\nusername=x-access-token\npassword=gh-token\n\n',
    })`git credential approve`;

    expect(approved.exitCode).toBe(0);
    const calls = existsSync(helperLog) ? await Bun.file(helperLog).text() : '';
    expect(calls).not.toContain('store');
    expect(calls).toBe('');
  });

  test("the user's helper still answers for other hosts", async () => {
    await useGh(
      'echo username=x-access-token\necho password=gh-token',
      '[credential]\n\thelper = "!f() { echo username=me; echo password=user-token; }; f"\n'
    );

    const result = await fill('example.com');

    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain('password=user-token');
    expect(existsSync(marker)).toBe(false);
  });

  test('other hosts never reach gh', async () => {
    await useGh('echo username=x-access-token\necho password=gh-token');

    const result = await fill('example.com');

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('gh calls in src/git.ts', () => {
  test('ghRepoIsForkOf hands gh the jq filter as one argument, with no literal quotes', async () => {
    await useGh(
      `[ "$7" = '.isFork and .parent.nameWithOwner == "up/repo"' ] && echo true || echo false`
    );

    expect(await ghRepoIsForkOf('acme/repo', 'up/repo')).toBe(true);
    expect(await ghRepoIsForkOf('acme/repo', 'other/repo')).toBe(false);
  });
});

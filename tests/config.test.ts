import { beforeEach, describe, expect, mock, test } from 'bun:test';

type MockResponse =
  | { exitCode: number; stdout: string; stderr: string }
  | ((command: string) => Promise<unknown>);

const execaCalls: string[] = [];
const mockResponses: Map<string, MockResponse> = new Map();
const writeFileCalls: Array<{ path: string; content: string }> = [];

mock.module('execa', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: Execa template mocks use flexible args.
  $: mock((stringsOrOptions: TemplateStringsArray | any, ...values: any[]) => {
    let command: string;

    if (
      typeof stringsOrOptions === 'object' &&
      !Array.isArray(stringsOrOptions)
    ) {
      // biome-ignore lint/suspicious/noExplicitAny: Template literal values type.
      return mock((strings: TemplateStringsArray, ...vals: any[]) => {
        command = String.raw({ raw: strings }, ...vals);
        execaCalls.push(command);
        return getMockExecaResponse(command);
      });
    }

    command = String.raw({ raw: stringsOrOptions }, ...values);
    execaCalls.push(command);
    return getMockExecaResponse(command);
  }),
}));

mock.module('node:fs/promises', () => ({
  mkdir: mock(() => Promise.resolve()),
  rm: mock(() => Promise.resolve()),
  readFile: mock(() =>
    Promise.resolve(
      JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/public.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
      })
    )
  ),
  writeFile: mock((path: string, content: string) => {
    writeFileCalls.push({ path, content });
    return Promise.resolve();
  }),
}));

function getMockExecaResponse(command: string) {
  for (const [pattern, response] of mockResponses.entries()) {
    if (command.includes(pattern)) {
      return typeof response === 'function'
        ? response(command)
        : Promise.resolve(response);
    }
  }

  if (command.includes('git fetch origin venfork-config')) {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  if (command.includes('git rev-parse FETCH_HEAD')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'cafebabe1234567890abcdef\n',
      stderr: '',
    });
  }
  if (command.includes('git show FETCH_HEAD:.venfork/config.json')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/public.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
      }),
      stderr: '',
    });
  }
  if (command.includes('git remote get-url origin')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'git@github.com:test/private.git',
      stderr: '',
    });
  }

  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
}

import {
  readVenforkConfigFromRepo,
  updateVenforkConfig,
} from '../src/config.js';

beforeEach(() => {
  execaCalls.length = 0;
  writeFileCalls.length = 0;
  mockResponses.clear();
});

describe('readVenforkConfigFromRepo', () => {
  test('returns parsed config from orphan branch', async () => {
    const result = await readVenforkConfigFromRepo('/tmp/repo');
    expect(result).toEqual({
      version: '1',
      publicForkUrl: 'git@github.com:test/public.git',
      upstreamUrl: 'git@github.com:upstream/repo.git',
    });
  });
});

const baseConfig = {
  version: '1' as const,
  publicForkUrl: 'git@github.com:test/public.git',
  upstreamUrl: 'git@github.com:upstream/repo.git',
};

function mockReadResponse(config: unknown) {
  return {
    exitCode: 0,
    stdout: JSON.stringify(config),
    stderr: '',
  };
}

describe('updateVenforkConfig', () => {
  test('merges schedule patch and writes updated config branch', async () => {
    const updated = await updateVenforkConfig('/tmp/repo', {
      schedule: { enabled: true, cron: '0 */6 * * *' },
    });

    expect(updated.schedule).toEqual({ enabled: true, cron: '0 */6 * * *' });
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('git push') &&
          cmd.includes('venfork-config:venfork-config')
      )
    ).toBe(true);
    expect(writeFileCalls.length).toBeGreaterThan(0);
    expect(writeFileCalls[0].content).toContain('"schedule"');
  });

  test('stores normalized enabled/disabled workflow policy', async () => {
    const updated = await updateVenforkConfig('/tmp/repo', {
      enabledWorkflows: [' ci.yml ', 'lint.yml', 'ci.yml'],
      disabledWorkflows: ['deploy.yml', ' deploy.yml '],
    });

    expect(updated.enabledWorkflows).toEqual(['ci.yml', 'lint.yml']);
    expect(updated.disabledWorkflows).toEqual(['deploy.yml']);
    expect(writeFileCalls.length).toBeGreaterThan(0);
    expect(writeFileCalls[writeFileCalls.length - 1].content).toContain(
      '"enabledWorkflows"'
    );
    expect(writeFileCalls[writeFileCalls.length - 1].content).toContain(
      '"disabledWorkflows"'
    );
  });

  test('stores normalized preserve allowlist and round-trips through write', async () => {
    const updated = await updateVenforkConfig('/tmp/repo', {
      preserve: [
        '  .github/workflows/caller.yml ',
        'docs/MIRROR.md',
        '.github/workflows/caller.yml',
      ],
    });

    expect(updated.preserve).toEqual([
      '.github/workflows/caller.yml',
      'docs/MIRROR.md',
    ]);
    expect(writeFileCalls.length).toBeGreaterThan(0);
    expect(writeFileCalls[writeFileCalls.length - 1].content).toContain(
      '"preserve"'
    );
  });

  test('clears preserve list when patch sets it to null', async () => {
    mockResponses.set(
      'git show FETCH_HEAD:.venfork/config.json',
      mockReadResponse({
        ...baseConfig,
        preserve: ['.github/workflows/caller.yml'],
      })
    );

    const updated = await updateVenforkConfig('/tmp/repo', {
      preserve: null,
    });

    expect(updated.preserve).toBeUndefined();
    expect(writeFileCalls[writeFileCalls.length - 1].content).not.toContain(
      '"preserve"'
    );
  });

  test('drops invalid preserve paths during normalize', async () => {
    const updated = await updateVenforkConfig('/tmp/repo', {
      preserve: [
        '/abs/path',
        '../escape',
        'foo/../bar',
        '.github/workflows/ok.yml',
        '',
      ],
    });

    // Only the well-formed relative path survives.
    expect(updated.preserve).toEqual(['.github/workflows/ok.yml']);
  });

  test('records and merges shippedBranches entries', async () => {
    // First ship: insert one entry.
    const first = await updateVenforkConfig('/tmp/repo', {
      shippedBranches: {
        'feat/auth': {
          upstreamPrUrl: 'https://github.com/upstream/repo/pull/123',
          head: 'abc1234',
          shippedAt: '2026-04-28T10:00:00Z',
          internalPrUrl: 'https://github.com/owner/mirror/pull/7',
        },
      },
    });
    expect(first.shippedBranches?.['feat/auth']?.upstreamPrUrl).toBe(
      'https://github.com/upstream/repo/pull/123'
    );

    // Subsequent updates merge rather than replace.
    mockResponses.set(
      'git show FETCH_HEAD:.venfork/config.json',
      mockReadResponse({
        ...baseConfig,
        shippedBranches: first.shippedBranches,
      })
    );

    // Second ship: add another branch entry; existing entry preserved.
    const second = await updateVenforkConfig('/tmp/repo', {
      shippedBranches: {
        'feat/api': {
          upstreamPrUrl: 'https://github.com/upstream/repo/pull/456',
          head: 'def5678',
          shippedAt: '2026-04-28T11:00:00Z',
        },
      },
    });
    expect(Object.keys(second.shippedBranches ?? {}).sort()).toEqual([
      'feat/api',
      'feat/auth',
    ]);

    // Per-entry deletion via null.
    mockResponses.set(
      'git show FETCH_HEAD:.venfork/config.json',
      mockReadResponse({
        ...baseConfig,
        shippedBranches: second.shippedBranches,
      })
    );
    const third = await updateVenforkConfig('/tmp/repo', {
      shippedBranches: { 'feat/auth': null },
    });
    expect(Object.keys(third.shippedBranches ?? {})).toEqual(['feat/api']);

    // Whole-field clear.
    mockResponses.set(
      'git show FETCH_HEAD:.venfork/config.json',
      mockReadResponse({
        ...baseConfig,
        shippedBranches: third.shippedBranches,
      })
    );
    const fourth = await updateVenforkConfig('/tmp/repo', {
      shippedBranches: null,
    });
    expect(fourth.shippedBranches).toBeUndefined();
  });

  test('records and merges pulledPrs entries with same semantics', async () => {
    const first = await updateVenforkConfig('/tmp/repo', {
      pulledPrs: {
        'upstream-pr/42': {
          upstreamPrNumber: 42,
          upstreamPrUrl: 'https://github.com/upstream/repo/pull/42',
          head: 'cafe1234',
          lastSyncedAt: '2026-04-28T10:00:00Z',
        },
      },
    });
    expect(first.pulledPrs?.['upstream-pr/42']?.upstreamPrNumber).toBe(42);
  });

  test('records and merges shippedIssues + pulledIssues', async () => {
    const first = await updateVenforkConfig('/tmp/repo', {
      shippedIssues: {
        '7': {
          internalIssueNumber: 7,
          internalIssueUrl: 'https://github.com/owner/mirror/issues/7',
          upstreamIssueNumber: 99,
          upstreamIssueUrl: 'https://github.com/upstream/repo/issues/99',
          shippedAt: '2026-04-28T10:00:00Z',
        },
      },
      pulledIssues: {
        '12': {
          upstreamIssueNumber: 200,
          upstreamIssueUrl: 'https://github.com/upstream/repo/issues/200',
          internalIssueNumber: 12,
          internalIssueUrl: 'https://github.com/owner/mirror/issues/12',
          pulledAt: '2026-04-28T11:00:00Z',
        },
      },
    });
    expect(first.shippedIssues?.['7']?.upstreamIssueNumber).toBe(99);
    expect(first.pulledIssues?.['12']?.upstreamIssueNumber).toBe(200);
  });

  test('drops malformed shippedBranches entries during normalize', async () => {
    mockResponses.set(
      'git show FETCH_HEAD:.venfork/config.json',
      mockReadResponse({
        ...baseConfig,
        shippedBranches: {
          good: {
            upstreamPrUrl: 'https://github.com/u/r/pull/1',
            head: 'aaa',
            shippedAt: '2026-04-28T10:00:00Z',
          },
          // missing required fields → dropped
          bad: { upstreamPrUrl: 'https://github.com/u/r/pull/2' },
        } as never,
      })
    );
    const updated = await updateVenforkConfig('/tmp/repo', {});
    expect(Object.keys(updated.shippedBranches ?? {})).toEqual(['good']);
  });

  test('writes config branch with --force-with-lease against the read sha', async () => {
    mockResponses.set('git rev-parse FETCH_HEAD', {
      exitCode: 0,
      stdout: 'deadbeef0000000000000000\n',
      stderr: '',
    });

    await updateVenforkConfig('/tmp/repo', {
      shippedBranches: {
        'feat/auth': {
          upstreamPrUrl: 'https://github.com/u/r/pull/1',
          head: 'aaa',
          shippedAt: '2026-04-28T10:00:00Z',
        },
      },
    });

    // The push should use the SHA captured during the read, not a fresh
    // ls-remote (which would race with concurrent writers).
    const pushCalls = execaCalls.filter(
      (cmd) =>
        cmd.includes('git push') &&
        cmd.includes('venfork-config:venfork-config')
    );
    expect(pushCalls.length).toBe(1);
    expect(pushCalls[0]).toContain(
      '--force-with-lease=venfork-config:deadbeef0000000000000000'
    );
  });

  test('retries on stale-info lease failure and succeeds with fresh state', async () => {
    // First push: lease failure (another venfork command got there first).
    // Second push: succeeds.
    let pushAttempt = 0;
    mockResponses.set('git push', (cmd: string) => {
      if (!cmd.includes('venfork-config:venfork-config')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      pushAttempt += 1;
      if (pushAttempt === 1) {
        return Promise.reject(
          new Error(
            '! [rejected] venfork-config -> venfork-config (stale info)'
          )
        );
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    // Each fetch+rev-parse pair returns a different SHA so we can confirm
    // the retry re-read.
    let fetchCount = 0;
    mockResponses.set('git rev-parse FETCH_HEAD', () => {
      fetchCount += 1;
      return Promise.resolve({
        exitCode: 0,
        stdout: fetchCount === 1 ? 'sha1\n' : 'sha2\n',
        stderr: '',
      });
    });

    const result = await updateVenforkConfig('/tmp/repo', {
      shippedBranches: {
        'feat/auth': {
          upstreamPrUrl: 'https://github.com/u/r/pull/1',
          head: 'aaa',
          shippedAt: '2026-04-28T10:00:00Z',
        },
      },
    });

    expect(pushAttempt).toBe(2);
    expect(fetchCount).toBeGreaterThanOrEqual(2); // re-read between attempts
    expect(result.shippedBranches?.['feat/auth']?.upstreamPrUrl).toBe(
      'https://github.com/u/r/pull/1'
    );
    // The successful retry leased against the second-read SHA.
    const successfulPush = execaCalls
      .filter(
        (cmd) =>
          cmd.includes('git push') &&
          cmd.includes('venfork-config:venfork-config')
      )
      .pop();
    expect(successfulPush).toContain('--force-with-lease=venfork-config:sha2');
  });

  test('throws after exhausting retries when every push hits stale-info', async () => {
    let pushAttempt = 0;
    mockResponses.set('git push', (cmd: string) => {
      if (!cmd.includes('venfork-config:venfork-config')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      pushAttempt += 1;
      return Promise.reject(
        new Error('! [rejected] venfork-config -> venfork-config (stale info)')
      );
    });

    await expect(
      updateVenforkConfig('/tmp/repo', {
        shippedBranches: {
          'feat/auth': {
            upstreamPrUrl: 'https://github.com/u/r/pull/1',
            head: 'aaa',
            shippedAt: '2026-04-28T10:00:00Z',
          },
        },
      })
    ).rejects.toThrow(/concurrent-write retries|stale info/i);

    // Bounded at MAX_RETRIES = 3.
    expect(pushAttempt).toBe(3);
  });

  test('does NOT retry on non-lease errors (e.g. auth failure)', async () => {
    let pushAttempt = 0;
    mockResponses.set('git push', (cmd: string) => {
      if (!cmd.includes('venfork-config:venfork-config')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      pushAttempt += 1;
      return Promise.reject(
        new Error('fatal: Authentication failed for github.com')
      );
    });

    await expect(
      updateVenforkConfig('/tmp/repo', {
        shippedBranches: {
          'feat/auth': {
            upstreamPrUrl: 'https://github.com/u/r/pull/1',
            head: 'aaa',
            shippedAt: '2026-04-28T10:00:00Z',
          },
        },
      })
    ).rejects.toThrow(/Authentication failed/);

    // Only one push attempt — we don't retry auth failures.
    expect(pushAttempt).toBe(1);
  });
});

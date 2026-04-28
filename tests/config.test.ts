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
});

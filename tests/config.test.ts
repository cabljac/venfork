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
});

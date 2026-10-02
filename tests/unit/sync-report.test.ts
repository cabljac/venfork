import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type MockResponse = { exitCode: number; stdout: string; stderr: string };
interface Call {
  command: string;
  input?: string;
}

const responses: Array<[string, MockResponse]> = [];
const calls: Call[] = [];

mock.module('execa', () => ({
  $:
    (options: { input?: string }) =>
    (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const command = String.raw(
        { raw: strings },
        ...vals.map((v) => (Array.isArray(v) ? v.join(' ') : String(v)))
      );
      calls.push({ command, input: options?.input });
      for (const [pattern, response] of responses) {
        if (command.includes(pattern)) return Promise.resolve(response);
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
}));

mock.module('@clack/prompts', () => ({
  log: { info: () => {}, warn: () => {} },
}));

import {
  reportSyncBlocked,
  resolveSyncBlocked,
} from '../../src/shared/sync-report.js';

const RUN_ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/widget-private',
  GITHUB_RUN_ID: '42',
};
const RUN_URL = 'https://github.com/acme/widget-private/actions/runs/42';
const REPORT = '  • origin/main has 1 commit(s) not in upstream';

function ghCalls(): Call[] {
  return calls.filter((call) => call.command.startsWith('gh '));
}

beforeEach(() => {
  responses.length = 0;
  calls.length = 0;
  responses.push([
    'git remote get-url origin',
    {
      exitCode: 0,
      stdout: 'https://github.com/acme/widget-private',
      stderr: '',
    },
  ]);
  Object.assign(process.env, RUN_ENV);
});

afterEach(() => {
  for (const key of Object.keys(RUN_ENV)) delete process.env[key];
});

describe('reportSyncBlocked', () => {
  test('creates the labelled issue when none is open', async () => {
    responses.unshift([
      'gh issue list',
      { exitCode: 0, stdout: '[]', stderr: '' },
    ]);

    await reportSyncBlocked({
      cwd: '/m',
      defaultBranch: 'main',
      report: REPORT,
    });

    const gh = ghCalls();
    expect(gh[0].command).toBe(
      'gh label create venfork-sync-blocked --repo acme/widget-private --color B60205 --description Scheduled venfork sync is blocked --force'
    );
    expect(gh[1].command).toBe(
      'gh issue list --repo acme/widget-private --label venfork-sync-blocked --state open --json number --limit 1'
    );
    expect(gh[2].command).toBe(
      'gh issue create --repo acme/widget-private --title Scheduled sync blocked: divergent commits on origin/main --label venfork-sync-blocked --body-file -'
    );
    expect(gh[2].input).toContain(REPORT);
    expect(gh[2].input).toContain(`Last blocked run: ${RUN_URL}`);
  });

  test('refreshes the body of an already open issue', async () => {
    responses.unshift([
      'gh issue list',
      { exitCode: 0, stdout: '[{"number":7}]', stderr: '' },
    ]);

    await reportSyncBlocked({
      cwd: '/m',
      defaultBranch: 'main',
      report: REPORT,
    });

    const gh = ghCalls();
    expect(gh.some((call) => call.command.startsWith('gh issue create'))).toBe(
      false
    );
    const edit = gh.find((call) => call.command.startsWith('gh issue edit'));
    expect(edit?.command).toBe(
      'gh issue edit 7 --repo acme/widget-private --body-file -'
    );
    expect(edit?.input).toContain(REPORT);
  });

  test('never throws when gh fails', async () => {
    responses.unshift([
      'gh label create',
      { exitCode: 1, stdout: '', stderr: 'HTTP 403' },
    ]);

    await expect(
      reportSyncBlocked({ cwd: '/m', defaultBranch: 'main', report: REPORT })
    ).resolves.toBeUndefined();
  });
});

describe('resolveSyncBlocked', () => {
  test('comments with the run URL and closes the open issue', async () => {
    responses.unshift([
      'gh issue list',
      { exitCode: 0, stdout: '[{"number":7}]', stderr: '' },
    ]);

    await resolveSyncBlocked({ cwd: '/m' });

    expect(ghCalls().at(-1)?.command).toBe(
      `gh issue close 7 --repo acme/widget-private --comment Resolved by ${RUN_URL}.`
    );
  });

  test('does nothing when no issue is open', async () => {
    responses.unshift([
      'gh issue list',
      { exitCode: 0, stdout: '[]', stderr: '' },
    ]);

    await resolveSyncBlocked({ cwd: '/m' });

    expect(
      ghCalls().map((call) => call.command.split(' ').slice(0, 3).join(' '))
    ).toEqual(['gh issue list']);
  });
});

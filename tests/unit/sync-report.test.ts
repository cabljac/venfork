import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type MockResponse = { exitCode: number; stdout: string; stderr: string };
interface Call {
  command: string;
  input?: string;
}

const responses: Array<[string, MockResponse]> = [];
const calls: Call[] = [];
const warnings: string[] = [];

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
  log: {
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
  },
}));

import { SyncDivergenceError } from '../../src/errors.js';
import {
  reportSyncBlocked,
  resolveReportRepo,
  resolveSyncBlocked,
  syncBlockedBody,
} from '../../src/shared/sync-report.js';

const RUN_ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/widget-private',
  GITHUB_RUN_ID: '42',
};
const RUN_URL = 'https://github.com/acme/widget-private/actions/runs/42';
const LIST_ISSUES =
  'gh api repos/acme/widget-private/issues?labels=venfork-sync-blocked&state=open&per_page=100';
const ORIGIN_ONLY = new SyncDivergenceError(
  'main',
  { count: 1, files: ['src/hotfix.ts'] },
  { count: 0, files: [] }
);
const PUBLIC_ONLY = new SyncDivergenceError(
  'main',
  { count: 0, files: [] },
  { count: 2, files: ['README.md'] }
);

function ok(stdout = ''): MockResponse {
  return { exitCode: 0, stdout, stderr: '' };
}

function ghCalls(): Call[] {
  return calls.filter((call) => call.command.startsWith('gh '));
}

function useOrigin(url: string): void {
  responses.push(['git remote get-url origin', ok(url)]);
}

beforeEach(() => {
  responses.length = 0;
  calls.length = 0;
  warnings.length = 0;
  for (const key of RUN_ENV_KEYS) delete process.env[key];
});

const RUN_ENV_KEYS = [...Object.keys(RUN_ENV), 'GITHUB_OUTPUT'];
const savedRunEnv = Object.fromEntries(
  RUN_ENV_KEYS.map((key) => [key, process.env[key]])
);

afterEach(() => {
  for (const [key, value] of Object.entries(savedRunEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resolveReportRepo', () => {
  test('ignores a GITHUB_REPOSITORY that is not origin and checks origin instead', async () => {
    Object.assign(process.env, RUN_ENV);
    useOrigin('git@github.com:acme/other.git');
    responses.push(['gh repo view acme/other', ok('false')]);

    expect(await resolveReportRepo('/m')).toBeNull();
    expect(ghCalls()[0].command).toBe(
      'gh repo view acme/other --json isPrivate -q .isPrivate'
    );
  });

  test('uses GITHUB_REPOSITORY inside Actions without asking gh', async () => {
    Object.assign(process.env, RUN_ENV);
    useOrigin('https://github.com/acme/widget-private.git');

    expect(await resolveReportRepo('/m')).toBe('acme/widget-private');
    expect(ghCalls()).toEqual([]);
  });

  test.each([
    ['SSH', 'git@github.com:acme/widget-private.git'],
    ['HTTPS with .git', 'https://github.com/acme/widget-private.git'],
  ])('uses a private %s origin', async (_label, url) => {
    useOrigin(url);
    responses.push(['gh repo view', ok('true')]);

    expect(await resolveReportRepo('/m')).toBe('acme/widget-private');
    expect(ghCalls()[0].command).toBe(
      'gh repo view acme/widget-private --json isPrivate -q .isPrivate'
    );
  });

  test('skips a public origin', async () => {
    useOrigin('git@github.com:acme/widget.git');
    responses.push(['gh repo view', ok('false')]);

    expect(await resolveReportRepo('/m')).toBeNull();
    expect(warnings[0]).toContain('acme/widget is not a private repository');
  });

  test('skips when gh cannot confirm visibility', async () => {
    useOrigin('git@github.com:acme/widget-private.git');
    responses.push([
      'gh repo view',
      { exitCode: 1, stdout: '', stderr: 'HTTP 404' },
    ]);

    expect(await resolveReportRepo('/m')).toBeNull();
    expect(warnings[0]).toContain('cannot confirm');
  });

  test.each([
    ['a non-GitHub origin', ok('/tmp/fixture/origin.git')],
    ['a missing origin', { exitCode: 2, stdout: '', stderr: 'No such remote' }],
  ])('skips %s', async (_label, response) => {
    responses.push(['git remote get-url origin', response]);

    expect(await resolveReportRepo('/m')).toBeNull();
    expect(ghCalls()).toEqual([]);
  });
});

describe('reportSyncBlocked', () => {
  beforeEach(() => {
    Object.assign(process.env, RUN_ENV);
    useOrigin('git@github.com:acme/widget-private.git');
  });

  test('creates the label only when missing, then opens the issue', async () => {
    responses.push(['gh label list', ok('[]')], [LIST_ISSUES, ok('[]')]);

    await reportSyncBlocked({ cwd: '/m', error: ORIGIN_ONLY });

    const gh = ghCalls().map((call) => call.command);
    expect(gh[0]).toBe(
      'gh label list --repo acme/widget-private --search venfork-sync-blocked --json name'
    );
    expect(gh[1]).toBe(
      'gh label create venfork-sync-blocked --repo acme/widget-private --color B60205 --description Scheduled venfork sync is blocked'
    );
    expect(gh[2]).toBe(LIST_ISSUES);
    expect(gh[3]).toBe(
      'gh issue create --repo acme/widget-private --title Scheduled sync blocked: divergent commits on origin/main --label venfork-sync-blocked --body-file -'
    );
    const created = ghCalls()[3];
    expect(created.input).toContain('src/hotfix.ts');
    expect(created.input).toContain(`Last blocked run: ${RUN_URL}`);
  });

  test('keeps an existing label and refreshes title and body of the open issue', async () => {
    responses.push(
      ['gh label list', ok('[{"name":"venfork-sync-blocked"}]')],
      [LIST_ISSUES, ok('[{"number":7}]')]
    );

    await reportSyncBlocked({ cwd: '/m', error: ORIGIN_ONLY });

    const gh = ghCalls();
    expect(gh.some((call) => call.command.startsWith('gh label create'))).toBe(
      false
    );
    const edit = gh.find((call) => call.command.startsWith('gh issue edit'));
    expect(edit?.command).toBe(
      'gh issue edit 7 --repo acme/widget-private --title Scheduled sync blocked: divergent commits on origin/main --body-file -'
    );
    expect(edit?.input).toContain('src/hotfix.ts');
  });

  test('names public in the title when only public diverged', async () => {
    responses.push(['gh label list', ok('[]')], [LIST_ISSUES, ok('[]')]);

    await reportSyncBlocked({ cwd: '/m', error: PUBLIC_ONLY });

    const created = ghCalls().find((call) =>
      call.command.startsWith('gh issue create')
    );
    expect(created?.command).toContain(
      '--title Scheduled sync blocked: divergent commits on public/main '
    );
    expect(created?.input).toContain(
      'cannot update the mirror: public/main carries commits'
    );
  });

  test('never throws when gh fails', async () => {
    responses.push([
      'gh label list',
      { exitCode: 1, stdout: '', stderr: 'HTTP 403' },
    ]);

    await expect(
      reportSyncBlocked({ cwd: '/m', error: ORIGIN_ONLY })
    ).resolves.toBeUndefined();
    expect(warnings[0]).toContain('HTTP 403');
  });

  test('a pull request carrying the label is not taken for the open issue', async () => {
    responses.push(
      ['gh label list', ok('[{"name":"venfork-sync-blocked"}]')],
      [LIST_ISSUES, ok('[{"number":3,"pull_request":{"url":"x"}}]')]
    );

    await reportSyncBlocked({ cwd: '/m', error: ORIGIN_ONLY });

    const gh = ghCalls().map((call) => call.command);
    expect(gh.some((cmd) => cmd.startsWith('gh issue create'))).toBe(true);
    expect(gh.some((cmd) => cmd.startsWith('gh issue edit'))).toBe(false);
  });

  describe('the step output', () => {
    let dir: string;
    let outputFile: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'venfork-output-'));
      outputFile = path.join(dir, 'output');
      await writeFile(outputFile, 'earlier=1\n');
      process.env.GITHUB_OUTPUT = outputFile;
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test.each([
      ['opened', '[]'],
      ['updated', '[{"number":7}]'],
    ])('appends reported=true once the issue is %s', async (_label, open) => {
      responses.push(
        ['gh label list', ok('[{"name":"venfork-sync-blocked"}]')],
        [LIST_ISSUES, ok(open)]
      );

      await reportSyncBlocked({ cwd: '/m', error: ORIGIN_ONLY });

      expect(await readFile(outputFile, 'utf8')).toBe(
        'earlier=1\nreported=true\n'
      );
    });

    test('writes nothing when reporting fails', async () => {
      responses.push([
        'gh label list',
        { exitCode: 1, stdout: '', stderr: 'HTTP 403' },
      ]);

      await reportSyncBlocked({ cwd: '/m', error: ORIGIN_ONLY });

      expect(await readFile(outputFile, 'utf8')).toBe('earlier=1\n');
    });
  });

  test('writes no step output outside Actions', async () => {
    responses.push(
      ['gh label list', ok('[{"name":"venfork-sync-blocked"}]')],
      [LIST_ISSUES, ok('[]')]
    );

    await reportSyncBlocked({ cwd: '/m', error: ORIGIN_ONLY });

    expect(warnings).toEqual([]);
  });
});

describe('syncBlockedBody', () => {
  test('caps the file list at 100 paths and the body under 60000 chars', () => {
    const files = Array.from(
      { length: 5000 },
      (_, i) => `src/${'deep/'.repeat(10)}file-${i}.ts`
    );
    const error = new SyncDivergenceError(
      'main',
      { count: 5000, files },
      { count: 0, files: [] }
    );

    const body = syncBlockedBody(error, RUN_URL);

    expect(body).toContain('file-99.ts');
    expect(body).not.toContain('file-100.ts');
    expect(body).toContain('...and 4900 more');
    expect(body.length).toBeLessThan(60_000);
  });
});

describe('resolveSyncBlocked', () => {
  beforeEach(() => {
    Object.assign(process.env, RUN_ENV);
    useOrigin('git@github.com:acme/widget-private.git');
  });

  test('closes every open labelled issue with the run URL', async () => {
    responses.push([LIST_ISSUES, ok('[{"number":7},{"number":8}]')]);

    await resolveSyncBlocked({ cwd: '/m' });

    expect(
      ghCalls()
        .map((call) => call.command)
        .filter((cmd) => cmd.startsWith('gh issue close'))
    ).toEqual([
      `gh issue close 7 --repo acme/widget-private --comment Resolved by ${RUN_URL}.`,
      `gh issue close 8 --repo acme/widget-private --comment Resolved by ${RUN_URL}.`,
    ]);
  });

  test('does nothing when no issue is open', async () => {
    responses.push([LIST_ISSUES, ok('[]')]);

    await resolveSyncBlocked({ cwd: '/m' });

    expect(ghCalls().map((call) => call.command)).toEqual([LIST_ISSUES]);
  });

  test('closes only issues, not pull requests the REST listing returns', async () => {
    responses.push([
      LIST_ISSUES,
      ok('[{"number":7},{"number":9,"pull_request":{"url":"x"}}]'),
    ]);

    await resolveSyncBlocked({ cwd: '/m' });

    expect(
      ghCalls()
        .map((call) => call.command)
        .filter((cmd) => cmd.startsWith('gh issue close'))
        .map((cmd) => cmd.split(' ')[3])
    ).toEqual(['7']);
  });

  test('logs and does not throw when closing fails', async () => {
    responses.push(
      [LIST_ISSUES, ok('[{"number":7}]')],
      ['gh issue close', { exitCode: 1, stdout: '', stderr: 'HTTP 502' }]
    );

    await expect(resolveSyncBlocked({ cwd: '/m' })).resolves.toBeUndefined();
    expect(warnings[0]).toContain('HTTP 502');
  });
});

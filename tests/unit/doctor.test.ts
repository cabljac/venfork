import { beforeEach, describe, expect, mock, test } from 'bun:test';

type MockResponse = { exitCode: number; stdout: string; stderr: string };

const responses: Array<[string, MockResponse]> = [];
const ghCalls: string[] = [];

function respond(command: string): Promise<MockResponse> {
  if (command.startsWith('gh ')) ghCalls.push(command);
  for (const [pattern, response] of responses) {
    if (command.includes(pattern)) return Promise.resolve(response);
  }
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
}

mock.module('execa', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: Mocking execa's overloaded template tag.
  $: (first: TemplateStringsArray | any, ...values: any[]) => {
    if (typeof first === 'object' && !Array.isArray(first)) {
      // biome-ignore lint/suspicious/noExplicitAny: Template literal values.
      return (strings: TemplateStringsArray, ...vals: any[]) =>
        respond(String.raw({ raw: strings }, ...vals));
    }
    return respond(String.raw({ raw: first }, ...values));
  },
}));

import { type DoctorCheck, runDoctorChecks } from '../../src/commands.js';
import { generateSyncWorkflow } from '../../src/workflow.js';

const CRON = '0 */6 * * *';
const RUN_URL = 'https://github.com/acme/widget-private/actions/runs/1';
const CREATED_AT = '2026-03-01T00:00:00Z';

function ok(stdout = ''): MockResponse {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr = 'failed'): MockResponse {
  return { exitCode: 1, stdout: '', stderr };
}

function useMirror(mode: 'standard' | 'no-public'): void {
  responses.length = 0;
  ghCalls.length = 0;
  const config = {
    version: '1',
    upstreamUrl: 'git@github.com:acme/widget.git',
    ...(mode === 'standard'
      ? { publicForkUrl: 'git@github.com:vendor/widget.git' }
      : { mode: 'no-public' }),
    schedule: { enabled: true, cron: CRON },
  };
  const remoteLines = [
    'origin\tgit@github.com:acme/widget-private.git (fetch)',
    'origin\tgit@github.com:acme/widget-private.git (push)',
    'upstream\tgit@github.com:acme/widget.git (fetch)',
    'upstream\tDISABLE (push)',
  ];
  if (mode === 'standard') {
    remoteLines.push(
      'public\tgit@github.com:vendor/widget.git (fetch)',
      'public\tgit@github.com:vendor/widget.git (push)'
    );
  }
  responses.push(
    ['git show FETCH_HEAD:.venfork/config.json', ok(JSON.stringify(config))],
    ['git rev-parse FETCH_HEAD', ok('configsha')],
    ['git remote -v', ok(remoteLines.join('\n'))],
    ['git symbolic-ref', ok('refs/remotes/upstream/main')],
    ['git rev-parse --verify origin/main^{commit}', ok('origintip')],
    ['git rev-parse --verify upstream/main^{commit}', ok('upstreamtip')],
    ['git rev-parse --verify origintip^^{commit}', ok('upstreamtip')],
    ['--format=%(trailers:key=Venfork-Managed,valueonly) origintip', ok('1')],
    [
      'git show origintip:.github/workflows/venfork-sync.yml',
      ok(generateSyncWorkflow(CRON, mode)),
    ]
  );
}

async function ghChecks(now?: Date): Promise<Record<string, DoctorCheck>> {
  const checks = await runDoctorChecks({ cwd: '/mirror', now });
  return Object.fromEntries(
    checks
      .filter((check) => ['token', 'last-run', 'cron-age'].includes(check.id))
      .map((check) => [check.id, check])
  );
}

function lastRun(conclusion: string | null, status = 'completed'): void {
  responses.unshift([
    'gh run list',
    ok(
      JSON.stringify([
        { conclusion, status, url: RUN_URL, createdAt: CREATED_AT },
      ])
    ),
  ]);
}

beforeEach(() => {
  useMirror('standard');
});

describe('doctor GitHub checks', () => {
  test('skip when gh is not authenticated', async () => {
    responses.unshift(['gh auth status', fail('not logged in')]);

    const checks = await ghChecks();

    for (const id of ['token', 'last-run', 'cron-age']) {
      expect(checks[id]).toEqual({
        id,
        ok: 'skipped',
        detail: 'gh is not authenticated',
      });
    }
    expect(ghCalls).toEqual(['gh auth status']);
  });

  test('token fails with the exact fix when VENFORK_PUSH_TOKEN is missing', async () => {
    responses.unshift(['gh secret list', ok('[{"name":"OTHER"}]')]);
    lastRun('success');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks.token.ok).toBe(false);
    expect(checks.token.fix).toBe(
      'gh secret set VENFORK_PUSH_TOKEN --repo acme/widget-private --body "$(gh auth token)"'
    );
    expect(
      ghCalls.some((cmd) =>
        cmd.includes('gh secret list --repo acme/widget-private --json name')
      )
    ).toBe(true);
  });

  test('token passes when the secret exists', async () => {
    responses.unshift([
      'gh secret list',
      ok('[{"name":"VENFORK_PUSH_TOKEN"}]'),
    ]);
    lastRun('success');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks.token).toEqual({
      id: 'token',
      ok: true,
      detail: 'VENFORK_PUSH_TOKEN is set',
    });
  });

  test('token is not needed in no-public mode', async () => {
    useMirror('no-public');
    lastRun('success');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks.token.ok).toBe(true);
    expect(ghCalls.some((cmd) => cmd.includes('gh secret list'))).toBe(false);
  });

  test('last-run fails and links the run when the last sync failed', async () => {
    responses.unshift([
      'gh secret list',
      ok('[{"name":"VENFORK_PUSH_TOKEN"}]'),
    ]);
    lastRun('failure');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks['last-run'].ok).toBe(false);
    expect(checks['last-run'].detail).toBe(`last run failure: ${RUN_URL}`);
    expect(
      ghCalls.some((cmd) =>
        cmd.includes(
          'gh run list --repo acme/widget-private --workflow venfork-sync.yml --limit 1 --json conclusion,status,url,createdAt'
        )
      )
    ).toBe(true);
  });

  test('cron-age passes within twice the cron interval and fails beyond it', async () => {
    responses.unshift([
      'gh secret list',
      ok('[{"name":"VENFORK_PUSH_TOKEN"}]'),
    ]);
    lastRun('success');

    const fresh = await ghChecks(new Date('2026-03-01T11:00:00Z'));
    expect(fresh['cron-age'].ok).toBe(true);

    const stale = await ghChecks(new Date('2026-03-01T13:00:00Z'));
    expect(stale['cron-age'].ok).toBe(false);
    expect(stale['cron-age'].detail).toBe(
      'last run 13h ago, but cron fires at least every 6h'
    );
  });

  test('no runs yet passes last-run and skips cron-age', async () => {
    responses.unshift(
      ['gh secret list', ok('[{"name":"VENFORK_PUSH_TOKEN"}]')],
      ['gh run list', ok('[]')]
    );

    const checks = await ghChecks();

    expect(checks['last-run']).toEqual({
      id: 'last-run',
      ok: true,
      detail: 'no runs yet',
    });
    expect(checks['cron-age'].ok).toBe('skipped');
  });

  test('a failing gh call skips its check with the gh error', async () => {
    responses.unshift(
      ['gh secret list', fail('HTTP 403: Resource not accessible')],
      ['gh run list', fail('HTTP 502')]
    );

    const checks = await ghChecks();

    expect(checks.token).toEqual({
      id: 'token',
      ok: 'skipped',
      detail:
        'cannot list secrets on acme/widget-private: HTTP 403: Resource not accessible',
    });
    expect(checks['last-run']).toEqual({
      id: 'last-run',
      ok: 'skipped',
      detail: 'cannot list runs: HTTP 502',
    });
    expect(checks['cron-age'].ok).toBe('skipped');
  });
});

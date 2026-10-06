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

import { doctorSummary } from '../../src/commands/doctor.js';
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

function useMirror(
  mode: 'standard' | 'no-public',
  extra: Record<string, unknown> = {}
): void {
  responses.length = 0;
  ghCalls.length = 0;
  const config = {
    version: '1',
    upstreamUrl: 'git@github.com:acme/widget.git',
    ...(mode === 'standard'
      ? { publicForkUrl: 'git@github.com:vendor/widget.git' }
      : { mode: 'no-public' }),
    schedule: { enabled: true, cron: CRON },
    ...extra,
  };
  const remotes: Array<[string, string, string]> = [
    [
      'origin',
      'git@github.com:acme/widget-private.git',
      'git@github.com:acme/widget-private.git',
    ],
    ['upstream', 'git@github.com:acme/widget.git', 'DISABLE'],
  ];
  if (mode === 'standard') {
    remotes.push([
      'public',
      'git@github.com:vendor/widget.git',
      'git@github.com:vendor/widget.git',
    ]);
  }
  responses.push(
    ['git show FETCH_HEAD:.venfork/config.json', ok(JSON.stringify(config))],
    ['git rev-parse FETCH_HEAD', ok('configsha')],
    ...remotes.flatMap(
      ([name, fetch, push]): Array<[string, MockResponse]> => [
        [`git remote get-url --push ${name}`, ok(push)],
        [`git remote get-url ${name}`, ok(fetch)],
      ]
    ),
    ['git remote', ok(remotes.map(([name]) => name).join('\n'))],
    ['git symbolic-ref', ok('refs/remotes/upstream/main')],
    ['git rev-parse --verify origin/main^{commit}', ok('origintip')],
    ['git rev-parse --verify upstream/main^{commit}', ok('upstreamtip')],
    ['git rev-parse --verify origintip^^{commit}', ok('upstreamtip')],
    ['--format=%(trailers:key=Venfork-Managed,valueonly) origintip', ok('1')],
    [
      'git show origintip:.github/workflows/venfork-sync.yml',
      ok(generateSyncWorkflow(CRON, mode)),
    ],
    [
      'gh api repos/acme/widget-private/actions/workflows/venfork-sync.yml',
      ok('active'),
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
      'gh secret set VENFORK_PUSH_TOKEN --repo acme/widget-private --body "<fine-grained token>"'
    );
    expect(checks.token.detail).toContain('never `gh auth token`');
    expect(
      ghCalls.some((cmd) =>
        cmd.includes('gh secret list --repo acme/widget-private --json name')
      )
    ).toBe(true);
  });

  test('token passes when the secret exists and warns while every upstream workflow can read it', async () => {
    responses.unshift([
      'gh secret list',
      ok('[{"name":"VENFORK_PUSH_TOKEN"}]'),
    ]);
    lastRun('success');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks.token.ok).toBe(true);
    expect(checks.token.detail).toBe(
      'VENFORK_PUSH_TOKEN is set; every upstream workflow on the mirror can read it'
    );
    expect(checks.token.fix).toContain('venfork workflows block');
  });

  test('token passes quietly when a workflow list filters upstream workflows', async () => {
    useMirror('standard', { disabledWorkflows: ['deploy.yml'] });
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

  test('token is required in no-public mode too', async () => {
    useMirror('no-public');
    responses.unshift(['gh secret list', ok('[]')]);
    lastRun('success');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks.token.ok).toBe(false);
    expect(checks.token.detail).toContain(
      'pushes of upstream commits that change .github/workflows will fail'
    );
    expect(checks.token.detail).toContain('Workflows write');
    expect(checks.token.detail).toContain('never `gh auth token`');
    expect(checks.token.detail).not.toContain('public fork');
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
      'last scheduled run 13h ago, but cron fires at least every 6h'
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

describe('doctor scheduled-run checks', () => {
  beforeEach(() => {
    responses.unshift([
      'gh secret list',
      ok('[{"name":"VENFORK_PUSH_TOKEN"}]'),
    ]);
  });

  test('cron-age reads only scheduled runs', async () => {
    lastRun('success');

    await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(
      ghCalls.some((cmd) =>
        cmd.includes(
          'gh run list --repo acme/widget-private --workflow venfork-sync.yml --event schedule --limit 1'
        )
      )
    ).toBe(true);
  });

  test('reads the workflow state through the REST API', async () => {
    lastRun('success');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks['cron-age'].ok).toBe(true);
    expect(ghCalls).toContain(
      'gh api repos/acme/widget-private/actions/workflows/venfork-sync.yml --jq .state'
    );
    expect(ghCalls.some((cmd) => cmd.startsWith('gh workflow view'))).toBe(
      false
    );
  });

  test.each(['disabled_inactivity', 'disabled_manually'])(
    'cron-age fails with a fix naming the Actions tab when the workflow is %s',
    async (state) => {
      responses.unshift([
        'gh api repos/acme/widget-private/actions/workflows/venfork-sync.yml',
        ok(state),
      ]);
      lastRun('success');

      const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

      expect(checks['cron-age']).toEqual({
        id: 'cron-age',
        ok: false,
        detail: `venfork-sync.yml is disabled (${state})`,
        fix: "Enable venfork-sync.yml in the mirror's Actions tab, or run `gh workflow enable venfork-sync.yml --repo acme/widget-private`.",
      });
    }
  );

  test('a stale cron-age fix does not recommend a manual dispatch', async () => {
    lastRun('success');

    const checks = await ghChecks(new Date('2026-03-01T13:00:00Z'));

    expect(checks['cron-age'].ok).toBe(false);
    expect(checks['cron-age'].fix).not.toContain('gh workflow run');
  });

  test('an in-progress last run says in progress', async () => {
    lastRun('', 'in_progress');

    const checks = await ghChecks(new Date('2026-03-01T01:00:00Z'));

    expect(checks['last-run']).toEqual({
      id: 'last-run',
      ok: true,
      detail: `last run in progress: ${RUN_URL}`,
    });
  });
});

describe('doctorSummary', () => {
  const check = (ok: DoctorCheck['ok']): DoctorCheck => ({
    id: 'x',
    ok,
    detail: '',
  });

  test('says all passed only when nothing was skipped', () => {
    expect(doctorSummary([check(true), check(true)])).toBe('All checks passed');
  });

  test('counts skipped checks instead of claiming all passed', () => {
    expect(doctorSummary([check(true), check(true), check('skipped')])).toBe(
      '2 passed, 1 skipped'
    );
  });

  test('counts failures first', () => {
    expect(doctorSummary([check(false), check(true), check('skipped')])).toBe(
      '1 failed, 1 passed, 1 skipped'
    );
  });
});

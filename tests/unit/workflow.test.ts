import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import {
  isUnpinnedWorkflow,
  pinnedVenforkVersion,
} from '../../src/shared/semver.js';
import { VENFORK_VERSION } from '../../src/version.js';
import {
  CREATE_APP_TOKEN_ACTION,
  generateSyncWorkflow,
  getSyncWorkflowPath,
  type SyncAuth,
} from '../../src/workflow.js';

describe('workflow helpers', () => {
  test('returns managed workflow path', () => {
    expect(getSyncWorkflowPath()).toBe('.github/workflows/venfork-sync.yml');
  });

  test('generates deterministic workflow with cron and dispatch trigger', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).toContain("cron: '0 */6 * * *'");
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('run: venfork sync --report-issues');
  });

  test('checkout uses the VENFORK_PUSH_TOKEN secret with no github.token fallback', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const checkout = workflow.slice(
      workflow.indexOf('- name: Checkout mirror'),
      workflow.indexOf('- name: Rewrite SSH')
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
    expect(checkout).toContain('token: ${{ secrets.VENFORK_PUSH_TOKEN }}');
    expect(checkout).not.toContain('github.token');
    expect(checkout).toContain('fetch-depth: 0');
  });

  test.each(['standard', 'no-public'] as const)(
    'fails fast before install when VENFORK_PUSH_TOKEN is empty (%s)',
    (mode) => {
      const workflow = generateSyncWorkflow('0 */6 * * *', mode);
      const check = workflow.indexOf('- name: Check VENFORK_PUSH_TOKEN');
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(workflow.indexOf('- name: Install venfork'));
      const step = workflow.slice(
        check,
        workflow.indexOf('- name: Install venfork')
      );
      expect(step).toContain('id: token-check');
      expect(step).toContain('if [ -z "$VENFORK_PUSH_TOKEN" ]; then');
      expect(step).toContain('::error::VENFORK_PUSH_TOKEN is not set');
      expect(step).toContain('exit 1');
    }
  );

  test('failure report names the missing token when the check step failed', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const step = workflow.slice(workflow.indexOf('- name: Report failed sync'));
    expect(step).toContain('if: failure()');
    expect(step).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      'TOKEN_CHECK: ${{ steps.token-check.outcome }}'
    );
    expect(step).toContain('if [ "$TOKEN_CHECK" = "failure" ]; then');
    expect(step).toContain('Cause: the VENFORK_PUSH_TOKEN secret is not set');
    expect(step).toContain(String.raw`$'\n\n'`);
    expect(step).toContain('--body "$MESSAGE"');
  });

  test('rewrites SSH GitHub URLs to HTTPS so extraheader auth applies', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).toContain('Rewrite SSH GitHub URLs to HTTPS');
    // Both SCP-style (git@github.com:) and ssh:// forms must rewrite to the
    // same HTTPS prefix that actions/checkout's extraheader auth covers.
    expect(workflow).toContain(
      'git config --global --add url."https://github.com/".insteadOf "git@github.com:"'
    );
    expect(workflow).toContain(
      'git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"'
    );
  });

  test.each([
    'ssh://git@github.com:22/',
    'ssh://git@ssh.github.com:443/',
    'git@GitHub.com:',
  ])('rewrites the %s SSH form to HTTPS', (form) => {
    expect(generateSyncWorkflow('0 */6 * * *')).toContain(
      `git config --global --add url."https://github.com/".insteadOf "${form}"`
    );
  });

  test('escapes cron safely for yaml single-quoted string', () => {
    const workflow = generateSyncWorkflow("0 */6 * * *'\n# injected");
    expect(workflow).toContain("cron: '0 */6 * * *'' # injected'");
  });

  test('standard mode emits public-remote configuration', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *', 'standard');
    expect(workflow).toContain('PUBLIC_URL=');
    expect(workflow).toContain('git remote add public');
    expect(workflow).toContain('Missing upstream/public URL in venfork-config');
  });

  test('no-public mode omits public-remote configuration', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *', 'no-public');
    expect(workflow).not.toContain('PUBLIC_URL=');
    expect(workflow).not.toContain('git remote add public');
    expect(workflow).not.toContain('git remote remove public');
    expect(workflow).toContain('Missing upstream URL in venfork-config');
    // Upstream + DISABLE-push guard remain in no-public mode.
    expect(workflow).toContain('git remote add upstream');
    expect(workflow).toContain('git remote set-url --push upstream DISABLE');
  });

  test('default mode is standard (back-compat with single-arg callers)', () => {
    const explicit = generateSyncWorkflow('0 */6 * * *', 'standard');
    const implicit = generateSyncWorkflow('0 */6 * * *');
    expect(implicit).toBe(explicit);
  });

  test('pins the venfork version in the install step', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *', 'standard', '1.2.3');
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell expansion we are asserting.
      'SPEC="${VENFORK_INSTALL_SPEC:-venfork@1.2.3}"'
    );
    expect(workflow).toMatchSnapshot();
  });

  test('defaults the pin to the running CLI version from package.json', () => {
    expect(VENFORK_VERSION).toBe(pkg.version);
    expect(generateSyncWorkflow('0 */6 * * *')).toContain(
      `SPEC="\${VENFORK_INSTALL_SPEC:-venfork@${pkg.version}}"`
    );
  });

  test('lets a repository variable override the install spec', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *', 'standard', '1.2.3');
    expect(workflow).toContain(
      `VENFORK_INSTALL_SPEC: \${{ vars.VENFORK_INSTALL_SPEC }}`
    );
    expect(workflow).toContain(`"\${VENFORK_INSTALL_SPEC:-venfork@1.2.3}"`);
  });

  test('grants issues: write and passes the job token to gh for issue reports', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).toContain(
      'permissions:\n  contents: write\n  issues: write\n'
    );
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      '      - name: Sync from upstream\n        id: sync\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: venfork sync --report-issues\n'
    );
  });

  test('final step reports any failed run on the venfork-sync-blocked issue', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const step = workflow.slice(workflow.indexOf('- name: Report failed sync'));
    expect(step).toContain('if: failure()');
    expect(step).toContain('gh label create venfork-sync-blocked');
    expect(step).toContain('gh issue create');
    expect(step).toContain('gh issue comment');
  });

  test('lists the open issue through REST, not the lagging search index', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).not.toContain('gh issue list');
    const step = workflow.slice(workflow.indexOf('- name: Report failed sync'));
    expect(step).toContain(
      `NUMBER="$(gh api "repos/$REPO/issues?labels=venfork-sync-blocked&state=open&per_page=100" --jq 'map(select(.pull_request == null))[0].number // empty')"`
    );
  });

  test('skips the failure report when the sync step already reported', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).toContain(
      '      - name: Sync from upstream\n        id: sync\n'
    );
    expect(workflow).toContain(
      "      - name: Report failed sync\n        if: failure() && steps.sync.outputs.reported != 'true'\n"
    );
  });

  test('installs venfork before checking out the mirror', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow.indexOf('- name: Install venfork')).toBeGreaterThan(-1);
    expect(workflow.indexOf('- name: Install venfork')).toBeLessThan(
      workflow.indexOf('- name: Checkout mirror')
    );
  });

  test('serializes runs and caps their duration', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      'concurrency:\n  group: venfork-sync-${{ github.workflow }}\n  cancel-in-progress: false\n'
    );
    expect(workflow).toContain(
      '  sync:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n'
    );
  });

  test('failure step creates the label only when it is missing', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const step = workflow.slice(workflow.indexOf('- name: Report failed sync'));
    expect(step).toContain(
      'gh label list --repo "$REPO" --search venfork-sync-blocked --json name --jq \'.[].name\' | grep -qx venfork-sync-blocked'
    );
    expect(step).not.toContain('--force');
  });
});

describe('failure report duplicate check', () => {
  test('reads the issue body into a variable instead of piping gh into grep -q', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const step = workflow.slice(workflow.indexOf('- name: Report failed sync'));
    expect(step).not.toMatch(/gh issue view[^\n]*\|\s*grep -q/);
    expect(step).toContain(
      'BODY="$(gh issue view "$NUMBER" --repo "$REPO" --json body --jq \'.body\')"'
    );
    expect(step).toContain('grep -qF "$RUN_URL" <<<"$BODY"');
  });
});

describe('install step spec validation', () => {
  function installScript(version: string): string {
    const workflow = generateSyncWorkflow('0 */6 * * *', 'standard', version);
    const start = workflow.indexOf('- name: Install venfork');
    const end = workflow.indexOf('- name: Checkout mirror');
    const step = workflow.slice(start, end);
    const body = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length);
    return body
      .split('\n')
      .map((line) => line.replace(/^ {10}/, ''))
      .join('\n');
  }

  function runInstall(spec: string | undefined): {
    status: number;
    npmArgs: string | null;
    stdout: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'venfork-install-'));
    const script = join(dir, 'install.sh');
    const log = join(dir, 'npm.log');
    writeFileSync(script, installScript('0.11.0'));
    const npm = join(dir, 'npm');
    writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
    chmodSync(npm, 0o755);
    const env: Record<string, string> = {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
    };
    if (spec !== undefined) env.VENFORK_INSTALL_SPEC = spec;
    const result = Bun.spawnSync(['bash', '-e', script], { env });
    let npmArgs: string | null = null;
    try {
      npmArgs = readFileSync(log, 'utf8');
    } catch {
      npmArgs = null;
    }
    return {
      status: result.exitCode ?? -1,
      npmArgs,
      stdout: result.stdout.toString(),
    };
  }

  test('runs the validation in bash', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const step = workflow.slice(
      workflow.indexOf('- name: Install venfork'),
      workflow.indexOf('- name: Checkout mirror')
    );
    expect(step).toContain('shell: bash');
    expect(step).toContain('::error::');
  });

  test('installs the pinned default when the variable is unset or empty', () => {
    for (const spec of [undefined, '']) {
      const result = runInstall(spec);
      expect(result.status).toBe(0);
      expect(result.npmArgs).toContain('venfork@0.11.0');
    }
  });

  test.each([
    'venfork@0.11.0',
    'venfork@1.0.0-rc.1',
    'https://registry.npmjs.org/venfork/-/venfork-0.11.0.tgz',
  ])('accepts %s', (spec) => {
    const result = runInstall(spec);
    expect(result.status).toBe(0);
    expect(result.npmArgs).toContain('--ignore-scripts');
    expect(result.npmArgs).toContain(spec);
  });

  test.each([
    'git+https://x/y',
    '--ignore-scripts=false',
    'venfork',
    'venfork@latest',
    'http://example.com/venfork.tgz',
    'https://example.com/venfork.zip',
    'venfork@0.11.0 evil',
  ])('rejects %s without installing', (spec) => {
    const result = runInstall(spec);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('::error::');
    expect(result.npmArgs).toBeNull();
  });
});

describe('GitHub App auth', () => {
  const publicRepo = { owner: 'Acme', name: 'project' };
  const appStandard: SyncAuth = { kind: 'app', publicRepo };
  const app = (mode: 'standard' | 'no-public' = 'standard') =>
    generateSyncWorkflow(
      '0 */6 * * *',
      mode,
      '1.2.3',
      mode === 'standard' ? appStandard : { kind: 'app' }
    );
  const stepOf = (workflow: string, name: string): string => {
    const start = workflow.indexOf(`- name: ${name}`);
    expect(start).toBeGreaterThan(-1);
    const next = workflow.indexOf('      - name: ', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };

  test('an explicit token auth gives the default workflow', () => {
    expect(
      generateSyncWorkflow('0 */6 * * *', 'standard', '1.2.3', {
        kind: 'token',
      })
    ).toBe(generateSyncWorkflow('0 */6 * * *', 'standard', '1.2.3'));
  });

  test.each(['standard', 'no-public'] as const)(
    'app workflow snapshot (%s)',
    (mode) => {
      expect(app(mode)).toMatchSnapshot();
    }
  );

  test('pins create-github-app-token by a full commit SHA', () => {
    expect(CREATE_APP_TOKEN_ACTION).toMatch(
      /^actions\/create-github-app-token@[0-9a-f]{40} # v\d+\.\d+\.\d+$/
    );
    expect(stepOf(app(), 'Mint GitHub App token')).toContain(
      `uses: ${CREATE_APP_TOKEN_ACTION}\n`
    );
  });

  test.each(['standard', 'no-public'] as const)(
    'never reads VENFORK_PUSH_TOKEN (%s)',
    (mode) => {
      expect(app(mode)).not.toContain('VENFORK_PUSH_TOKEN');
    }
  );

  test('checks the secrets before install and mints the token before checkout', () => {
    const workflow = app();
    const order = [
      '- name: Check VENFORK_APP_CLIENT_ID and VENFORK_APP_PRIVATE_KEY',
      '- name: Install venfork',
      '- name: Mint GitHub App token',
      '- name: Checkout mirror',
    ].map((name) => workflow.indexOf(name));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('checkout uses the minted token with no github.token fallback', () => {
    const checkout = stepOf(app(), 'Checkout mirror');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
    expect(checkout).toContain('token: ${{ steps.app-token.outputs.token }}');
    expect(checkout).not.toContain('github.token');
  });

  test('scopes the token to the mirror and the public fork with only contents and workflows write', () => {
    const mint = stepOf(app(), 'Mint GitHub App token');
    expect(mint).toContain('id: app-token\n');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expressions we are asserting.
    expect(mint).toContain('client-id: ${{ secrets.VENFORK_APP_CLIENT_ID }}');
    expect(mint).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      'private-key: ${{ secrets.VENFORK_APP_PRIVATE_KEY }}'
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
    expect(mint).toContain('owner: ${{ github.repository_owner }}');
    expect(mint).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      'repositories: ${{ steps.token-check.outputs.mirror }},project\n'
    );
    expect(mint).toContain('permission-contents: write\n');
    expect(mint).toContain('permission-workflows: write\n');
    expect(mint.match(/permission-/g)).toHaveLength(2);
  });

  test('no-public scopes the token to the mirror only', () => {
    const mint = stepOf(app('no-public'), 'Mint GitHub App token');
    expect(mint).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      'repositories: ${{ steps.token-check.outputs.mirror }}\n'
    );
    expect(app('no-public')).not.toContain('different owner');
  });

  test('issue reports keep the job token and name the App secrets', () => {
    const step = stepOf(app(), 'Report failed sync');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expressions we are asserting.
    expect(step).toContain('GH_TOKEN: ${{ github.token }}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
    expect(step).toContain('APP_TOKEN: ${{ steps.app-token.outcome }}');
    expect(step).toContain(
      'Set both VENFORK_APP_CLIENT_ID and VENFORK_APP_PRIVATE_KEY'
    );
    expect(step).toContain('elif [ "$APP_TOKEN" = "failure" ]; then');
    expect(step).toContain('installed on $REPO and Acme/project');
    expect(stepOf(app(), 'Sync from upstream')).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      'GH_TOKEN: ${{ github.token }}'
    );
  });

  test('keeps the pinned version readable', () => {
    for (const mode of ['standard', 'no-public'] as const) {
      expect(pinnedVenforkVersion(app(mode))).toBe('1.2.3');
      expect(isUnpinnedWorkflow(app(mode))).toBe(false);
      expect(app(mode).match(/venfork@/g)).toEqual(
        generateSyncWorkflow('0 */6 * * *', mode, '1.2.3').match(/venfork@/g)
      );
    }
  });

  test.each([
    { owner: 'acme', name: 'pro ject' },
    { owner: 'ac"me', name: 'project' },
    { owner: 'acme', name: 'x$(id)' },
  ])('refuses an unsafe public fork name %p', (repo) => {
    expect(() =>
      generateSyncWorkflow('0 */6 * * *', 'standard', '1.2.3', {
        kind: 'app',
        publicRepo: repo,
      })
    ).toThrow('Unsafe public fork name');
  });

  test('standard mode refuses app auth without the public fork', () => {
    expect(() =>
      generateSyncWorkflow('0 */6 * * *', 'standard', '1.2.3', { kind: 'app' })
    ).toThrow('needs the public fork');
  });

  describe('secret check script', () => {
    function runCheck(
      mode: 'standard' | 'no-public',
      env: Record<string, string>
    ): { status: number; stdout: string; output: string } {
      const step = stepOf(app(mode), 'Check VENFORK_APP_CLIENT_ID');
      const body = step
        .slice(step.indexOf('run: |\n') + 'run: |\n'.length)
        .split('\n')
        .map((line) => line.replace(/^ {10}/, ''))
        .join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'venfork-app-check-'));
      const script = join(dir, 'check.sh');
      const output = join(dir, 'output');
      writeFileSync(script, body);
      writeFileSync(output, '');
      const result = Bun.spawnSync(['bash', script], {
        env: {
          PATH: process.env.PATH ?? '',
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'acme/project-private',
          GITHUB_REPOSITORY_OWNER: 'acme',
          VENFORK_APP_CLIENT_ID: 'Iv1.abc',
          VENFORK_APP_PRIVATE_KEY: 'key',
          ...env,
        },
      });
      return {
        status: result.exitCode ?? -1,
        stdout: result.stdout.toString(),
        output: readFileSync(output, 'utf8'),
      };
    }

    test('passes and outputs the mirror name when both secrets are set', () => {
      for (const mode of ['standard', 'no-public'] as const) {
        const result = runCheck(mode, {});
        expect(result.status).toBe(0);
        expect(result.output).toBe('mirror=project-private\n');
      }
    });

    test('names every missing secret with a gh secret set command', () => {
      const result = runCheck('standard', {
        VENFORK_APP_CLIENT_ID: '',
        VENFORK_APP_PRIVATE_KEY: '',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        '::error::VENFORK_APP_CLIENT_ID is not set on this repository.'
      );
      expect(result.stdout).toContain(
        'gh secret set VENFORK_APP_CLIENT_ID --repo acme/project-private --body <client-id>'
      );
      expect(result.stdout).toContain(
        '::error::VENFORK_APP_PRIVATE_KEY is not set on this repository.'
      );
      expect(result.stdout).toContain(
        'gh secret set VENFORK_APP_PRIVATE_KEY --repo acme/project-private < <key.pem>'
      );
      expect(result.output).toBe('');
    });

    test('fails when only the private key is missing', () => {
      const result = runCheck('no-public', { VENFORK_APP_PRIVATE_KEY: '' });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('VENFORK_APP_CLIENT_ID is not set');
      expect(result.stdout).toContain('VENFORK_APP_PRIVATE_KEY is not set');
    });

    test('compares the owner case-insensitively and refuses a different one', () => {
      expect(
        runCheck('standard', { GITHUB_REPOSITORY_OWNER: 'ACME' }).status
      ).toBe(0);
      const other = runCheck('standard', {
        GITHUB_REPOSITORY: 'other/project-private',
        GITHUB_REPOSITORY_OWNER: 'other',
      });
      expect(other.status).toBe(1);
      expect(other.stdout).toContain(
        '::error::The public fork Acme/project has a different owner than other/project-private.'
      );
      expect(other.output).toBe('');
    });
  });
});

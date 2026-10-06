import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { VENFORK_VERSION } from '../../src/version.js';
import {
  generateSyncWorkflow,
  getSyncWorkflowPath,
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
      '      - name: Sync from upstream\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: venfork sync --report-issues\n'
    );
  });

  test('final step reports any failed run on the venfork-sync-blocked issue', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const step = workflow.slice(workflow.indexOf('- name: Report failed sync'));
    expect(step).toContain('if: failure()');
    expect(step).toContain('gh label create venfork-sync-blocked');
    expect(step).toContain('--label venfork-sync-blocked --state open');
    expect(step).toContain('gh issue create');
    expect(step).toContain('gh issue comment');
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

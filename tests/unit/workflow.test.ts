import { describe, expect, test } from 'bun:test';
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
      `run: npm install -g --ignore-scripts "\${VENFORK_INSTALL_SPEC:-venfork@1.2.3}"`
    );
    expect(workflow).toMatchSnapshot();
  });

  test('defaults the pin to the running CLI version from package.json', () => {
    expect(VENFORK_VERSION).toBe(pkg.version);
    expect(generateSyncWorkflow('0 */6 * * *')).toContain(
      `run: npm install -g --ignore-scripts "\${VENFORK_INSTALL_SPEC:-venfork@${pkg.version}}"`
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

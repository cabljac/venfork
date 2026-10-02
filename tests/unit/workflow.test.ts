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

  test('checkout step wires VENFORK_PUSH_TOKEN with github.token fallback', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    const expectedTokenLine =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GHA expression we are asserting.
      'token: ${{ secrets.VENFORK_PUSH_TOKEN || github.token }}';
    expect(workflow).toContain(expectedTokenLine);
    expect(workflow).toContain('fetch-depth: 0');
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
      `run: npm install -g "\${VENFORK_INSTALL_SPEC:-venfork@1.2.3}"`
    );
    expect(workflow).toMatchSnapshot();
  });

  test('defaults the pin to the running CLI version from package.json', () => {
    expect(VENFORK_VERSION).toBe(pkg.version);
    expect(generateSyncWorkflow('0 */6 * * *')).toContain(
      `run: npm install -g "\${VENFORK_INSTALL_SPEC:-venfork@${pkg.version}}"`
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

  test('serializes runs and caps their duration', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).toContain(
      'concurrency:\n  group: venfork-sync\n  cancel-in-progress: false\n'
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

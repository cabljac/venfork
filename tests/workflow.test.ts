import { describe, expect, test } from 'bun:test';
import { generateSyncWorkflow, getSyncWorkflowPath } from '../src/workflow.js';

describe('workflow helpers', () => {
  test('returns managed workflow path', () => {
    expect(getSyncWorkflowPath()).toBe('.github/workflows/venfork-sync.yml');
  });

  test('generates deterministic workflow with cron and dispatch trigger', () => {
    const workflow = generateSyncWorkflow('0 */6 * * *');
    expect(workflow).toContain("cron: '0 */6 * * *'");
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('run: venfork sync');
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
});

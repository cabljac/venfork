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
});

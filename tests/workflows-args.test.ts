import { describe, expect, test } from 'bun:test';
import { parseWorkflowsCliArgs } from '../src/workflows-args.js';

describe('parseWorkflowsCliArgs', () => {
  test('defaults to status', () => {
    expect(parseWorkflowsCliArgs([])).toEqual({
      action: 'status',
      workflows: [],
    });
  });

  test('parses allow values and normalizes comma-separated input', () => {
    expect(
      parseWorkflowsCliArgs(['allow', 'ci.yml,lint.yml', 'build.yml'])
    ).toEqual({
      action: 'allow',
      workflows: ['ci.yml', 'lint.yml', 'build.yml'],
    });
  });

  test('parses clear command', () => {
    expect(parseWorkflowsCliArgs(['clear'])).toEqual({
      action: 'clear',
      workflows: [],
    });
  });

  test('parses block values', () => {
    expect(parseWorkflowsCliArgs(['block', 'deploy.yml', 'e2e.yml'])).toEqual({
      action: 'block',
      workflows: ['deploy.yml', 'e2e.yml'],
    });
  });

  test('throws for allow without values', () => {
    expect(() => parseWorkflowsCliArgs(['allow'])).toThrow();
  });

  test('throws for block without values', () => {
    expect(() => parseWorkflowsCliArgs(['block'])).toThrow();
  });

  test('throws for unknown action', () => {
    expect(() => parseWorkflowsCliArgs(['unknown'])).toThrow();
  });
});

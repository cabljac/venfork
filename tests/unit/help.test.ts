import { describe, expect, test } from 'bun:test';
import { commandHelp } from '../../src/commands/help.js';

describe('commandHelp', () => {
  test('sync help names no flag that sync does not accept', () => {
    const usage = commandHelp('sync', []) ?? '';
    expect(usage).toContain('venfork sync [branch] [--report-issues]');
    expect(usage).not.toContain('--no-public');
    expect(usage).toContain('no-public mode');
  });

  test('workflows help lists the add and remove actions', () => {
    const usage = commandHelp('workflows', []) ?? '';
    expect(usage).toContain(
      'venfork workflows <status|allow|block|unallow|unblock|clear>'
    );
  });

  test.each([
    ['clone', []],
    ['sync', []],
    ['doctor', []],
    ['schedule', []],
    ['workflows', []],
    ['preserve', []],
    ['pull', []],
    ['pull', ['pr']],
  ] as const)(
    'the %s %p usage line shows the prompt flags',
    (command, rest) => {
      const usage = commandHelp(command, [...rest]) ?? '';
      expect(usage.split('\n')[0]).toContain('[--yes] [--no-input] [--json]');
    }
  );
});

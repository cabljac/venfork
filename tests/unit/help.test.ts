import { describe, expect, test } from 'bun:test';
import { commandHelp, helpTopics, showHelp } from '../../src/commands/help.js';
import type { Ui } from '../../src/shared/ui.js';

describe('commandHelp', () => {
  test('sync help names no flag that sync does not accept', () => {
    const usage = commandHelp('sync', []) ?? '';
    expect(usage).toContain('venfork sync [--report-issues]');
    expect(usage).not.toContain('--own-upstream');
    expect(usage).toContain('unless the mirror has no public fork');
  });

  test('help topics cover every command and subcommand entry', () => {
    const names = helpTopics().map(([command, rest]) =>
      [command, ...rest].join(' ')
    );
    expect(names).toContain('keep');
    expect(names).toContain('pull pr');
    expect(names).toContain('stage issue');
    for (const [command, rest] of helpTopics()) {
      expect(commandHelp(command, [...rest])).not.toBeNull();
    }
  });

  test('clone help names the real condition for detection, not a version', () => {
    const usage = commandHelp('clone', []) ?? '';
    expect(usage).not.toContain('0.9');
    expect(usage).toContain('For a mirror with no venfork settings');
    expect(usage).toContain(
      'Options (only when the mirror has no venfork settings)'
    );
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
    ['keep', []],
    ['pull', []],
    ['pull', ['pr']],
  ] as const)(
    'the %s %p usage line shows the prompt flags',
    (command, rest) => {
      const usage = commandHelp(command, [...rest]) ?? '';
      expect(usage.split('\n')[0]).toContain('[--yes] [--no-input] [--json]');
    }
  );

  test('no command help names an implementation term or an old flag name', () => {
    const notes: string[] = [];
    const noop = () => {};
    const ui: Ui = {
      log: {
        info: noop,
        success: noop,
        step: noop,
        warn: noop,
        error: noop,
        message: noop,
      },
      note: (message) => notes.push(message),
      intro: noop,
      outro: noop,
      cancel: noop,
      spinner: () => ({
        start: noop,
        stop: noop,
        error: noop,
        cancel: noop,
        message: noop,
        clear: noop,
      }),
    };
    showHelp(ui);
    const texts = [
      ...notes,
      ...helpTopics().map(
        ([command, rest]) => commandHelp(command, [...rest]) ?? ''
      ),
    ];
    const banned = [
      'no-public',
      'preserve',
      'managed commit',
      'orphan',
      '+0/+1',
      'enabledWorkflows',
      'disabledWorkflows',
      'venfork-config',
      'scheduleAuth',
      'legacy',
      'venfork-managed',
    ];
    for (const text of texts) {
      expect(text).not.toBe('');
      for (const term of banned) {
        expect(text.toLowerCase()).not.toContain(term.toLowerCase());
      }
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  commandHelp,
  helpTopic,
  helpTopics,
  showHelp,
} from '../../src/commands/help.js';
import { createUi, type Ui } from '../../src/shared/ui.js';

const SCREEN_WIDTH = 80;
const SCREEN_LINES = 36;

/** The lines `showHelp` writes to a plain (non-TTY) stream. */
function renderPlain(): string[] {
  let written = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      written += String(chunk);
      done();
    },
  });
  showHelp(createUi(() => stream));
  const lines = written.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Collects everything `showHelp` prints into one string. */
function renderHelp(): string {
  const out: string[] = [];
  const push = (text: string) => {
    out.push(text);
  };
  const ui: Ui = {
    log: {
      info: push,
      success: push,
      step: push,
      warn: push,
      error: push,
      message: push,
    },
    note: (message, title) => {
      out.push(title ?? '', message);
    },
    intro: push,
    outro: push,
    cancel: push,
    spinner: () => ({
      start: () => {},
      stop: () => {},
      error: () => {},
      cancel: () => {},
      message: () => {},
      clear: () => {},
    }),
  };
  showHelp(ui);
  return out.join('\n');
}

describe('showHelp', () => {
  test('fits 36 lines of 80 columns as plain text', () => {
    const lines = renderPlain();
    expect(lines.length).toBeLessThanOrEqual(SCREEN_LINES);
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(SCREEN_WIDTH);
    }
  });

  test('says --yes and --no-input work on every command, and dry run pushes nothing', () => {
    const text = renderHelp();
    expect(text).toMatch(/--yes.*--no-input.*every command/);
    expect(text).toMatch(/--dry-run.*push nothing/);
    expect(text).not.toContain('offline');
  });

  test('groups the commands, one line each', () => {
    const text = renderHelp();
    for (const group of [
      'Get started',
      'Every day',
      'Review upstream work',
      'Automation',
      'Advanced',
    ]) {
      expect(text).toContain(group);
    }
    for (const command of [
      'setup',
      'clone',
      'sync',
      'stage',
      'doctor',
      'pull pr',
      'pull issue',
      'stage issue',
      'schedule',
      'keep',
      'workflows',
    ]) {
      expect(text).toMatch(new RegExp(`^  ${command} `, 'm'));
    }
    expect(text).toContain('venfork <command> --help');
  });

  test('leaves environment variables and exit codes to their own topics', () => {
    const text = renderHelp();
    expect(text).not.toContain('VENFORK_GIT_TIMEOUT');
    expect(text).not.toMatch(/^\s*143 /m);
    expect(text).toContain('venfork help env');
    expect(text).toContain('venfork help exit-codes');
  });

  test('names no implementation term', () => {
    const text = renderHelp();
    for (const term of [
      'managed commit',
      'venfork-config',
      '+0/+1',
      'legacy',
    ]) {
      expect(text).not.toContain(term);
    }
  });
});

describe('helpTopic', () => {
  test('env lists every VENFORK_ variable the CLI reads, and NO_COLOR', () => {
    const srcDir = join(import.meta.dir, '../../src');
    const read = new Set<string>();
    for (const file of readdirSync(srcDir, { recursive: true })) {
      if (!String(file).endsWith('.ts')) continue;
      const source = readFileSync(join(srcDir, String(file)), 'utf8');
      for (const match of source.matchAll(/process\.env\.(VENFORK_[A-Z_]+)/g)) {
        read.add(match[1] ?? '');
      }
    }
    expect(read.size).toBeGreaterThanOrEqual(6);
    const text = helpTopic('env') ?? '';
    for (const name of [...read, 'NO_COLOR']) {
      expect(text).toContain(name);
    }
  });

  test('exit-codes lists 0, 1, 2, 130 and 143', () => {
    const text = helpTopic('exit-codes') ?? '';
    for (const code of ['0', '1', '2', '130', '143']) {
      expect(text).toMatch(new RegExp(`^${code} `, 'm'));
    }
  });

  test('exit-codes names partial success under 1 and every cancel under 130', () => {
    const text = helpTopic('exit-codes') ?? '';
    expect(text).toMatch(/^1 .*partial success/m);
    const cancel = text.slice(text.indexOf('\n130 '), text.indexOf('\n143 '));
    for (const cause of [
      'prompt',
      'input ended',
      'SIGINT',
      'terminal closed',
    ]) {
      expect(cancel).toContain(cause);
    }
  });

  test.each(['env', 'exit-codes'])('the %s topic fits 80 columns', (topic) => {
    for (const line of (helpTopic(topic) ?? '').split('\n')) {
      expect([...line].length).toBeLessThanOrEqual(SCREEN_WIDTH);
    }
  });

  test('an unknown topic is null', () => {
    expect(helpTopic('sync')).toBeNull();
  });
});

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

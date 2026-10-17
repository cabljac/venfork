import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Writable } from 'node:stream';
import { ON_STDERR, quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import * as clack from '@clack/prompts';
import { createUi, isRich, log, note, stdoutUi } from '../../src/shared/ui.js';

function fakeStream(isTTY: boolean) {
  const chunks: string[] = [];
  const stream = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    { isTTY }
  );
  return { stream, text: () => chunks.join('') };
}

const originalTerm = process.env.TERM;

afterEach(() => {
  delete process.env.NO_COLOR;
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
});

describe('plain rendering', () => {
  test('each log level prints its prefix and the message, with no ESC byte', () => {
    const { stream, text } = fakeStream(false);
    const ui = createUi(() => stream);
    ui.log.info('fetching');
    ui.log.success('fetched');
    ui.log.step('checking');
    ui.log.warn('careful');
    ui.log.error('broken');
    ui.log.message('bare');
    ui.intro('Venfork Sync');
    ui.outro('Done');
    ui.cancel('Operation cancelled');
    expect(text()).toBe(
      [
        'info: fetching',
        'ok: fetched',
        'step: checking',
        'warn: careful',
        'error: broken',
        'bare',
        'Venfork Sync',
        'Done',
        'cancelled: Operation cancelled',
        '',
      ].join('\n')
    );
    expect(text()).not.toContain('\x1b');
    expect(clack.log.error).not.toHaveBeenCalled();
  });

  test('indents continuation lines and note bodies under their title', () => {
    const { stream, text } = fakeStream(false);
    const ui = createUi(() => stream);
    ui.log.error('Sync blocked\nrun venfork doctor');
    ui.note('a.txt\nb.txt', 'Files');
    ui.note('untitled');
    expect(text()).toBe(
      'error: Sync blocked\n  run venfork doctor\nFiles:\n  a.txt\n  b.txt\n  untitled\n'
    );
    expect(clack.note).not.toHaveBeenCalled();
  });

  test('a spinner prints one line at start and one at stop, and drops message updates', () => {
    const { stream, text } = fakeStream(false);
    const s = createUi(() => stream).spinner();
    s.start('Fetching from upstream');
    s.message('still fetching');
    s.stop('Fetched');
    s.start('Pushing');
    s.stop();
    s.start('Checking');
    s.error('Check failed');
    expect(text()).toBe(
      [
        'step: Fetching from upstream',
        'done: Fetched',
        'step: Pushing',
        'done: Pushing',
        'step: Checking',
        'error: Check failed',
        '',
      ].join('\n')
    );
  });

  test('NO_COLOR forces plain output on a TTY', () => {
    const { stream, text } = fakeStream(true);
    process.env.NO_COLOR = '1';
    expect(isRich(stream)).toBe(false);
    createUi(() => stream).log.warn('careful');
    expect(text()).toBe('warn: careful\n');
    expect(clack.log.warn).not.toHaveBeenCalled();
  });

  test('TERM=dumb forces plain output on a TTY', () => {
    const { stream, text } = fakeStream(true);
    process.env.TERM = 'dumb';
    expect(isRich(stream)).toBe(false);
    createUi(() => stream).log.warn('careful');
    expect(text()).toBe('warn: careful\n');
    expect(clack.log.warn).not.toHaveBeenCalled();
  });

  test('reads the TTY flag on every call', () => {
    const { stream, text } = fakeStream(true);
    const ui = createUi(() => stream);
    ui.log.warn('rich');
    stream.isTTY = false;
    ui.log.warn('plain');
    expect(clack.log.warn).toHaveBeenCalledTimes(1);
    expect(text()).toBe('warn: plain\n');
  });
});

describe('rich rendering', () => {
  test('an empty NO_COLOR keeps clack rendering on a TTY', () => {
    process.env.NO_COLOR = '';
    expect(isRich(fakeStream(true).stream)).toBe(true);
  });

  test('the exported helpers hand clack process.stderr on a TTY', () => {
    log.error('broken');
    note('body', 'Title');
    expect(clack.log.error).toHaveBeenCalledWith('broken', ON_STDERR);
    expect(clack.note).toHaveBeenCalledWith('body', 'Title', ON_STDERR);
  });
});

describe('streams', () => {
  test('the exported helpers write plain lines to stderr, never stdout', () => {
    const tty = process.stderr.isTTY;
    process.stderr.isTTY = false;
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      log.info('progress');
      expect(err).toHaveBeenCalledWith('info: progress\n');
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
      process.stderr.isTTY = tty;
    }
  });

  test('stdoutUi writes to stdout', () => {
    const tty = process.stdout.isTTY;
    process.stdout.isTTY = false;
    const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      stdoutUi.note('venfork sync', 'Available Commands');
      expect(out).toHaveBeenCalledWith('Available Commands:\n  venfork sync\n');
    } finally {
      out.mockRestore();
      process.stdout.isTTY = tty;
    }
  });
});

import type { Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import { CommandExitError, isEntryReported } from '../errors.js';

/** A stream that ui output is written to. */
export type UiStream = Writable & { isTTY?: boolean };

/** The levels of {@link Ui.log}, each with its plain-mode prefix. */
const PLAIN_PREFIX = {
  info: 'info:',
  success: 'ok:',
  step: 'step:',
  warn: 'warn:',
  error: 'error:',
} as const;

type LogLevel = keyof typeof PLAIN_PREFIX;

/** A spinner; in plain mode `start` and `stop` each print one line. */
export interface UiSpinner {
  start(message?: string): void;
  stop(message?: string): void;
  error(message?: string): void;
  cancel(message?: string): void;
  /** Updates the spinner text; plain mode drops it. */
  message(message?: string): void;
  clear(): void;
}

/** Human output helpers bound to one stream. */
export interface Ui {
  log: Record<LogLevel, (message: string) => void> & {
    /** A message with no level prefix. */
    message(message: string): void;
  };
  note(message: string, title?: string): void;
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  spinner(): UiSpinner;
}

/**
 * True when `stream` gets clack's styled rendering: it is a TTY,
 * `NO_COLOR` is unset or empty, and `TERM` is not `dumb`. Read on every
 * call.
 */
export function isRich(stream: UiStream): boolean {
  return (
    stream.isTTY === true &&
    (process.env.NO_COLOR ?? '') === '' &&
    process.env.TERM !== 'dumb'
  );
}

function plainLines(stream: UiStream, prefix: string, message: string): void {
  const [first = '', ...rest] = message.split('\n');
  const head = prefix ? `${prefix} ${first}` : first;
  stream.write(`${[head, ...rest.map((line) => `  ${line}`)].join('\n')}\n`);
}

function plainSpinner(stream: () => UiStream): UiSpinner {
  let current = '';
  const line = (prefix: string, message?: string) =>
    plainLines(stream(), prefix, message ?? current);
  return {
    start(message) {
      current = message ?? '';
      line('step:', current);
    },
    stop: (message) => line('done:', message),
    error: (message) => line('error:', message),
    cancel: (message) => line('cancelled:', message),
    message() {},
    clear() {},
  };
}

/**
 * Builds the ui helpers for the stream `stream()` returns. Each call picks
 * clack or plain rendering with {@link isRich}.
 */
export function createUi(stream: () => UiStream): Ui {
  const output = () => ({ output: stream() });
  const level =
    (name: LogLevel) =>
    (message: string): void => {
      const s = stream();
      if (isRich(s)) clack.log[name](message, output());
      else plainLines(s, PLAIN_PREFIX[name], message);
    };
  return {
    log: {
      info: level('info'),
      success: level('success'),
      step: level('step'),
      warn: level('warn'),
      error: level('error'),
      message(message) {
        const s = stream();
        if (isRich(s)) clack.log.message(message, output());
        else plainLines(s, '', message);
      },
    },
    note(message, title) {
      const s = stream();
      if (isRich(s)) {
        clack.note(message, title, output());
        return;
      }
      const body = message.replace(/^/gm, '  ');
      s.write(title ? `${title}:\n${body}\n` : `${body}\n`);
    },
    intro(title) {
      const s = stream();
      if (isRich(s)) clack.intro(title, output());
      else plainLines(s, '', title);
    },
    outro(message) {
      const s = stream();
      if (isRich(s)) clack.outro(message, output());
      else plainLines(s, '', message);
    },
    cancel(message) {
      const s = stream();
      if (isRich(s)) clack.cancel(message, output());
      else plainLines(s, 'cancelled:', message);
    },
    spinner() {
      const s = stream();
      if (!isRich(s)) return plainSpinner(stream);
      const spin = clack.spinner(output());
      return {
        start: (message) => spin.start(message),
        stop: (message) => spin.stop(message),
        error: (message) => spin.error(message),
        cancel: (message) => spin.cancel(message),
        message: (message) => spin.message(message),
        clear: () => spin.clear(),
      };
    },
  };
}

/** Ui helpers on stderr, for human output (the default). */
export const stderrUi: Ui = createUi(() => process.stderr);

/**
 * Reports a command failure as one `error:` line on stderr, after clearing
 * `spinner`, and returns the {@link CommandExitError} for the command to
 * throw. An error `src/index.ts` reports itself is returned unprinted.
 */
export function reportFailure(error: unknown, spinner?: UiSpinner): unknown {
  spinner?.clear();
  if (isEntryReported(error)) return error;
  stderrUi.log.error(error instanceof Error ? error.message : String(error));
  return new CommandExitError(1, error);
}

/** Human output on stderr: progress, warnings, errors and reports. */
export const { log, note, intro, outro, cancel, spinner } = stderrUi;

/** Ui helpers on stdout, for output that is the command's result (help). */
export const stdoutUi: Ui = createUi(() => process.stdout);

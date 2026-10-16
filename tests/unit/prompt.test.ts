import { afterEach, describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import * as clack from '@clack/prompts';
import { MissingInputError } from '../../src/errors.js';
import {
  canPrompt,
  promptConfirm,
  promptText,
} from '../../src/shared/prompt.js';

type ClackTextOptions = Parameters<typeof clack.text>[0];

function lastTextOptions(): ClackTextOptions {
  const calls = (clack.text as ReturnType<typeof mock>).mock.calls;
  return calls.at(-1)?.[0] as ClackTextOptions;
}

function setStdinTty(value: boolean): void {
  process.stdin.isTTY = value;
}

const NO_FLAGS = { yes: false, noInput: false };

afterEach(() => {
  delete process.env.CI;
  delete process.env.VENFORK_NONINTERACTIVE;
});

describe('canPrompt', () => {
  const ciValues: Array<[string | undefined, boolean]> = [
    [undefined, true],
    ['', true],
    ['false', true],
    ['0', true],
    ['true', false],
    ['1', false],
  ];
  const cases: Array<
    [boolean, string | undefined, string | undefined, boolean, boolean]
  > = [];
  for (const tty of [true, false]) {
    for (const [ci, ciAllows] of ciValues) {
      for (const nonInteractive of [undefined, '1', '0']) {
        for (const noInput of [false, true]) {
          cases.push([
            tty,
            ci,
            nonInteractive,
            noInput,
            tty && ciAllows && nonInteractive !== '1' && !noInput,
          ]);
        }
      }
    }
  }

  test.each(cases)(
    'isTTY=%p CI=%p VENFORK_NONINTERACTIVE=%p noInput=%p -> %p',
    (tty, ci, nonInteractive, noInput, expected) => {
      setStdinTty(tty);
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
      if (nonInteractive === undefined)
        delete process.env.VENFORK_NONINTERACTIVE;
      else process.env.VENFORK_NONINTERACTIVE = nonInteractive;

      expect(canPrompt({ noInput })).toBe(expected);
    }
  );
});

describe('canPrompt and stderr', () => {
  test('is false when stderr is not a TTY, since prompts render there', () => {
    setStdinTty(true);
    delete process.env.CI;
    delete process.env.VENFORK_NONINTERACTIVE;
    const stderrTty = process.stderr.isTTY;
    try {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: false,
        configurable: true,
        writable: true,
      });
      expect(canPrompt()).toBe(false);
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: stderrTty,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('promptText', () => {
  test('hands validate an empty string when clack passes undefined', async () => {
    await promptText({
      message: 'Name?',
      flag: '--name',
      validate: (value) => (value === '' ? 'required' : undefined),
    });
    const validate = lastTextOptions().validate;
    expect(typeof validate).toBe('function');
    if (typeof validate !== 'function') return;
    expect(await validate(undefined)).toBe('required');
    expect(await validate('x')).toBeUndefined();
  });

  test('an empty answer validates as defaultValue', async () => {
    await promptText({
      message: 'Name?',
      flag: '--name',
      defaultValue: 'project-private',
      validate: (value) => (value === '' ? 'required' : undefined),
    });
    const validate = lastTextOptions().validate;
    expect(typeof validate).toBe('function');
    if (typeof validate !== 'function') return;
    expect(await validate(undefined)).toBeUndefined();
    expect(await validate('')).toBeUndefined();
  });

  test('does not pass the flag through to clack', async () => {
    await promptText({ message: 'Org?', flag: '--org' });
    expect(lastTextOptions()).toEqual({
      message: 'Org?',
      output: process.stderr,
      validate: undefined,
    });
  });

  test('without a TTY it returns the default without prompting', async () => {
    setStdinTty(false);
    const text = clack.text as ReturnType<typeof mock>;
    text.mockClear();

    const answer = await promptText({
      message: 'Name?',
      flag: '[name]',
      defaultValue: 'repo-private',
    });

    expect(answer).toBe('repo-private');
    expect(text).not.toHaveBeenCalled();
  });

  test('without a TTY and no default it throws MissingInputError naming the flag', async () => {
    setStdinTty(false);

    const err = await promptText({
      message: 'Upstream?',
      flag: '--upstream <url>',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MissingInputError);
    expect((err as MissingInputError).flag).toBe('--upstream <url>');
    expect((err as MissingInputError).message).toContain(
      'Pass --upstream <url>.'
    );
  });

  test('a default that fails validation is not used without a prompt', async () => {
    const err = await promptText(
      {
        message: 'Name?',
        flag: '[name]',
        defaultValue: 'bad name',
        validate: (value) => (value.includes(' ') ? 'no spaces' : undefined),
      },
      { yes: false, noInput: true }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MissingInputError);
  });
});

describe('promptConfirm', () => {
  test('--yes answers yes without prompting, even at a TTY', async () => {
    const confirm = clack.confirm as ReturnType<typeof mock>;
    confirm.mockClear();

    expect(
      await promptConfirm({ message: 'Go?' }, { yes: true, noInput: false })
    ).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  test('--yes answers yes when prompting is impossible', async () => {
    setStdinTty(false);
    expect(
      await promptConfirm({ message: 'Go?' }, { yes: true, noInput: true })
    ).toBe(true);
  });

  test('VENFORK_NONINTERACTIVE=1 without --yes throws naming --yes', async () => {
    process.env.VENFORK_NONINTERACTIVE = '1';

    const err = await promptConfirm({ message: 'Go?' }, NO_FLAGS).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(MissingInputError);
    expect((err as MissingInputError).flag).toBe('--yes');
    expect((err as MissingInputError).question).toBe('Go?');
  });

  test('at a TTY without --yes it asks clack on stderr', async () => {
    const confirm = clack.confirm as ReturnType<typeof mock>;
    confirm.mockClear();

    await promptConfirm({ message: 'Go?', initialValue: false });

    expect(confirm).toHaveBeenCalledWith({
      message: 'Go?',
      initialValue: false,
      output: process.stderr,
    });
  });
});

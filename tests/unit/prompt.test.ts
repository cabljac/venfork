import { describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import * as clack from '@clack/prompts';
import { promptText } from '../../src/shared/prompt.js';

type ClackTextOptions = Parameters<typeof clack.text>[0];

function lastTextOptions(): ClackTextOptions {
  const calls = (clack.text as ReturnType<typeof mock>).mock.calls;
  return calls.at(-1)?.[0] as ClackTextOptions;
}

describe('promptText', () => {
  test('hands validate an empty string when clack passes undefined', async () => {
    await promptText({
      message: 'Name?',
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
});

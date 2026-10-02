import { describe, expect, mock, test } from 'bun:test';
import { quietPrompts } from '../harness/prompts.js';

mock.module('@clack/prompts', quietPrompts);

import * as prompts from '@clack/prompts';

describe('quietPrompts', () => {
  test('records log.error calls', () => {
    prompts.log.error('boom');
    expect(prompts.log.error).toHaveBeenCalledTimes(1);
  });

  test('starts each test with a cleared log.error mock', () => {
    expect(prompts.log.error).not.toHaveBeenCalled();
  });
});

import { mock } from 'bun:test';

/**
 * Silent stand-in for `@clack/prompts` so commands run without a TTY.
 * Every confirm answers yes.
 */
export function quietPrompts() {
  const noop = () => {};
  return {
    intro: noop,
    outro: noop,
    note: noop,
    cancel: noop,
    spinner: () => ({ start: noop, stop: noop, message: noop }),
    log: {
      error: noop,
      warn: noop,
      info: noop,
      success: noop,
      step: noop,
      message: noop,
    },
    confirm: mock(() => Promise.resolve(true)),
    text: mock(() => Promise.resolve('')),
    isCancel: () => false,
  };
}

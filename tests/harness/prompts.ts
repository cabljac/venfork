import { mock } from 'bun:test';

/**
 * Silent stand-in for `@clack/prompts` so commands run without a TTY.
 * Every confirm answers yes; `log.error` is a mock so tests can read errors.
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
      error: mock(noop),
      warn: noop,
      info: noop,
      success: noop,
      step: noop,
      message: noop,
    },
    confirm: mock(() => Promise.resolve(true)),
    text: mock(() => Promise.resolve('')),
    select: mock(() => Promise.resolve(undefined)),
    multiselect: mock(() => Promise.resolve([])),
    group: mock(() => Promise.resolve({})),
    isCancel: () => false,
  };
}

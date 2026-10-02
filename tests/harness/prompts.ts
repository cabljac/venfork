import { mock } from 'bun:test';

const noop = () => {};
const logError = mock(noop);

/** Clears recorded prompt calls; the test preload runs it before each test. */
export function resetQuietPrompts(): void {
  logError.mockClear();
}

/**
 * Silent stand-in for `@clack/prompts` so commands run without a TTY.
 * Every confirm answers yes; `log.error` is a mock, cleared before each
 * test by the preload, so tests can read errors.
 */
export function quietPrompts() {
  return {
    intro: noop,
    outro: noop,
    note: noop,
    cancel: noop,
    spinner: () => ({ start: noop, stop: noop, message: noop }),
    log: {
      error: logError,
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

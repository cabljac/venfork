import { mock } from 'bun:test';

const noop = () => {};
const logError = mock(noop);
const logWarn = mock(noop);
const note = mock(noop);

/** Clears recorded prompt calls; the test preload runs it before each test. */
export function resetQuietPrompts(): void {
  logError.mockClear();
  logWarn.mockClear();
  note.mockClear();
}

/**
 * Silent stand-in for `@clack/prompts` so commands run without a TTY.
 * Every confirm answers yes; `log.error`, `log.warn` and `note` are mocks,
 * cleared before each test by the preload, so tests can read them.
 */
export function quietPrompts() {
  return {
    intro: noop,
    outro: noop,
    note,
    cancel: noop,
    spinner: () => ({ start: noop, stop: noop, message: noop }),
    log: {
      error: logError,
      warn: logWarn,
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

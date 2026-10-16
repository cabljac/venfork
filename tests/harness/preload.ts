import { beforeEach, mock } from 'bun:test';
import { resetQuietPrompts } from './prompts.js';

/**
 * Replaces `process.exit` for every test file so a command that exits
 * cannot end the run early with a passing status.
 */
const exitStub = mock((code?: number | string | null) => {
  throw new Error(`process.exit(${code ?? ''})`);
});

process.exit = exitStub as unknown as typeof process.exit;

/**
 * Pins src/shared/ui.ts to rich mode, so command output reaches the mocked
 * `@clack/prompts` instead of the real stderr whatever runs the tests.
 */
function pinRichUi(): void {
  Object.defineProperty(process.stderr, 'isTTY', {
    value: true,
    configurable: true,
    writable: true,
  });
  delete process.env.NO_COLOR;
  if (process.env.TERM === 'dumb') delete process.env.TERM;
}

pinRichUi();

/** Re-installs the stub and clears shared mocks before every test. */
beforeEach(() => {
  process.exit = exitStub as unknown as typeof process.exit;
  exitStub.mockClear();
  pinRichUi();
  resetQuietPrompts();
});

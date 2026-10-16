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

function pinTty(stream: NodeJS.ReadStream | NodeJS.WriteStream): void {
  Object.defineProperty(stream, 'isTTY', {
    value: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Pins src/shared/ui.ts to rich mode and src/shared/prompt.ts to "may
 * prompt", so output and prompts reach the mocked `@clack/prompts`
 * whatever runs the tests, CI included.
 */
function pinRichUi(): void {
  pinTty(process.stderr);
  pinTty(process.stdin);
  delete process.env.NO_COLOR;
  if (process.env.TERM === 'dumb') delete process.env.TERM;
  delete process.env.CI;
  delete process.env.VENFORK_NONINTERACTIVE;
}

pinRichUi();

/** Re-installs the stub and clears shared mocks before every test. */
beforeEach(() => {
  process.exit = exitStub as unknown as typeof process.exit;
  exitStub.mockClear();
  pinRichUi();
  resetQuietPrompts();
});

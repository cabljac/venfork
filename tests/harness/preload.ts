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

/** Re-installs the stub and clears shared mocks before every test. */
beforeEach(() => {
  process.exit = exitStub as unknown as typeof process.exit;
  exitStub.mockClear();
  resetQuietPrompts();
});

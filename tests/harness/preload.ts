import { beforeEach, mock } from 'bun:test';

/**
 * Replaces `process.exit` for every test file so a command that exits
 * cannot end the run early with a passing status.
 */
const exitStub = mock((code?: number | string | null) => {
  throw new Error(`process.exit(${code ?? ''})`);
});

process.exit = exitStub as unknown as typeof process.exit;

beforeEach(() => {
  process.exit = exitStub as unknown as typeof process.exit;
  exitStub.mockClear();
});

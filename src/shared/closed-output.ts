/**
 * The exit code for an error on stdin, stdout or stderr, or null when the
 * error is not a closed stream and must stay fatal. A reader that stopped
 * early (`venfork help | head -1`, EPIPE) keeps the exit code so far. A
 * terminal that hung up (EIO: on Linux, reads and writes on a pty fail
 * once its master closes) ended the run like a cancel, so it exits 130.
 *
 * @param error The stream's `error` event.
 * @param exitCode `process.exitCode` at the time.
 */
export function closedOutputExitCode(
  error: NodeJS.ErrnoException,
  exitCode: number | string | null | undefined
): number | null {
  if (error.code === 'EIO') return 130;
  if (error.code === 'EPIPE') return Number(exitCode ?? 0) || 0;
  return null;
}

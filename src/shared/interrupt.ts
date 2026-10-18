let claims = 0;

/**
 * Marks that the running command handles SIGINT and SIGTERM itself (it
 * cleans up, then rejects with `CommandExitError` 130 for SIGINT or 143 for
 * SIGTERM), so `src/index.ts`
 * leaves the signal to it. Call the returned function when the command
 * removes its handlers.
 */
export function claimInterrupts(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims--;
  };
}

/** True while a command holds a {@link claimInterrupts} claim. */
export function interruptsClaimed(): boolean {
  return claims > 0;
}

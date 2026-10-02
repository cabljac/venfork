import * as p from '@clack/prompts';

/**
 * `p.confirm` wrapper that can return `true` immediately when
 * `VENFORK_NONINTERACTIVE=1` is set in the environment, but only for
 * callers that explicitly opt into that behavior by passing
 * `allowNonInteractive: true`. This lets scripts and tests bypass intended
 * interactive confirms without turning every prompt into an implicit "yes"
 * in CI/non-interactive environments.
 */
export async function confirmOrAutoYes(opts: {
  message: string;
  initialValue?: boolean;
  allowNonInteractive?: boolean;
}): Promise<boolean | symbol> {
  if (
    opts.allowNonInteractive === true &&
    process.env.VENFORK_NONINTERACTIVE === '1'
  ) {
    return true;
  }
  return p.confirm(opts);
}

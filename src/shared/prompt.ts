import * as p from '@clack/prompts';

/** Fields every prompt takes. */
export interface PromptOptions {
  message: string;
  /** The CLI flag that supplies this value without a prompt, e.g. `--org`. */
  flag?: string;
}

/** Options for {@link promptText}. */
export interface TextPromptOptions extends PromptOptions {
  placeholder?: string;
  /** The answer used when the user submits an empty line. */
  defaultValue?: string;
  /** Returns an error message to re-ask, or `undefined` to accept. */
  validate?: (value: string) => string | undefined;
}

/** Options for {@link promptConfirm}. */
export interface ConfirmPromptOptions extends PromptOptions {
  initialValue?: boolean;
}

/** Options for {@link confirmOrAutoYes}. */
export interface AutoYesConfirmOptions extends ConfirmPromptOptions {
  /** Lets `VENFORK_NONINTERACTIVE=1` answer yes without asking. */
  allowNonInteractive?: boolean;
}

/**
 * Asks for one line of text.
 * @returns The answer, or the cancel symbol (check with {@link isCancel}).
 */
export async function promptText(
  opts: TextPromptOptions
): Promise<string | symbol> {
  const { flag: _flag, validate, ...clackOpts } = opts;
  return p.text({
    ...clackOpts,
    // clack validates before it substitutes defaultValue for an empty line.
    validate:
      validate && ((value) => validate(value || (opts.defaultValue ?? ''))),
  });
}

/**
 * Asks a yes/no question.
 * @returns The answer, or the cancel symbol (check with {@link isCancel}).
 */
export async function promptConfirm(
  opts: ConfirmPromptOptions
): Promise<boolean | symbol> {
  const { flag: _flag, ...clackOpts } = opts;
  return p.confirm(clackOpts);
}

/**
 * {@link promptConfirm}, but answers `true` without asking when
 * `VENFORK_NONINTERACTIVE=1` and the caller sets `allowNonInteractive`.
 * Other prompts never become an implicit yes.
 */
export async function confirmOrAutoYes(
  opts: AutoYesConfirmOptions
): Promise<boolean | symbol> {
  const { allowNonInteractive, ...confirmOpts } = opts;
  if (
    allowNonInteractive === true &&
    process.env.VENFORK_NONINTERACTIVE === '1'
  ) {
    return true;
  }
  return promptConfirm(confirmOpts);
}

/** True when a prompt answer is the cancel symbol (Ctrl-C or Esc). */
export function isCancel(value: unknown): value is symbol {
  return p.isCancel(value);
}

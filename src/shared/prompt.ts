import * as p from '@clack/prompts';
import { MissingInputError } from '../errors.js';
import * as ui from './ui.js';

/** How the user asked one command run to treat prompts. */
export interface PromptContext {
  /** `--yes`: answer every confirm of the command with yes. */
  yes: boolean;
  /** `--no-input`: never prompt. */
  noInput: boolean;
}

/** The context of a run with neither `--yes` nor `--no-input`. */
export const DEFAULT_PROMPT_CONTEXT: PromptContext = {
  yes: false,
  noInput: false,
};

/** Fields every prompt takes. */
export interface PromptOptions {
  message: string;
  /**
   * The CLI flag or argument that supplies this value without a prompt,
   * e.g. `--upstream`. Named in the {@link MissingInputError}.
   */
  flag: string;
}

/** Options for {@link promptText}. */
export interface TextPromptOptions extends PromptOptions {
  placeholder?: string;
  /**
   * The answer used when the user submits an empty line, and without a
   * prompt when {@link canPrompt} is false.
   */
  defaultValue?: string;
  /** Returns an error message to re-ask, or `undefined` to accept. */
  validate?: (value: string) => string | undefined;
}

/** Options for {@link promptConfirm}. `--yes` always supplies the answer. */
export interface ConfirmPromptOptions {
  message: string;
  initialValue?: boolean;
}

function ciIsSet(): boolean {
  const ci = process.env.CI ?? '';
  return ci !== '' && ci !== 'false' && ci !== '0';
}

/**
 * True when venfork may show a prompt: stdin and stderr (where prompts
 * render) are TTYs, `CI` is unset, empty, `false` or `0`,
 * `VENFORK_NONINTERACTIVE` is not `1`, and the run did not pass
 * `--no-input`. Reads the environment on every call.
 */
export function canPrompt(
  context: Pick<PromptContext, 'noInput'> = DEFAULT_PROMPT_CONTEXT
): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stderr.isTTY === true &&
    !ciIsSet() &&
    process.env.VENFORK_NONINTERACTIVE !== '1' &&
    !context.noInput
  );
}

/**
 * Asks for one line of text. When {@link canPrompt} is false it returns
 * `defaultValue` (and logs it), or throws {@link MissingInputError}.
 * @returns The answer, or the cancel symbol (check with {@link isCancel}).
 */
export async function promptText(
  opts: TextPromptOptions,
  context: PromptContext = DEFAULT_PROMPT_CONTEXT
): Promise<string | symbol> {
  const { flag, validate, ...clackOpts } = opts;
  if (!canPrompt(context)) {
    const fallback = opts.defaultValue;
    if (fallback === undefined || validate?.(fallback) !== undefined) {
      throw new MissingInputError(flag, opts.message);
    }
    ui.log.info(`${opts.message} ${fallback} (default; pass ${flag} to set)`);
    return fallback;
  }
  return p.text({
    ...clackOpts,
    output: process.stderr,
    // clack validates before it substitutes defaultValue for an empty line.
    validate:
      validate && ((value) => validate(value || (opts.defaultValue ?? ''))),
  });
}

/**
 * Asks a yes/no question. `--yes` answers it with yes; when
 * {@link canPrompt} is false and `--yes` is absent it throws
 * {@link MissingInputError} naming `--yes`.
 * @returns The answer, or the cancel symbol (check with {@link isCancel}).
 */
export async function promptConfirm(
  opts: ConfirmPromptOptions,
  context: PromptContext = DEFAULT_PROMPT_CONTEXT
): Promise<boolean | symbol> {
  if (context.yes) return true;
  if (!canPrompt(context)) throw new MissingInputError('--yes', opts.message);
  return p.confirm({ ...opts, output: process.stderr });
}

/**
 * Throws the {@link MissingInputError} that {@link promptConfirm} would
 * throw for `message`, so a command can refuse before slow or network work
 * when it could never get the answer.
 */
export function assertCanConfirm(
  message: string,
  context: PromptContext = DEFAULT_PROMPT_CONTEXT
): void {
  if (!context.yes && !canPrompt(context)) {
    throw new MissingInputError('--yes', message);
  }
}

/** True when a prompt answer is the cancel symbol (Ctrl-C or Esc). */
export function isCancel(value: unknown): value is symbol {
  return p.isCancel(value);
}

import type { PromptContext } from './prompt.js';

/**
 * Read the value of `--flag value` or `--flag=value` at `args[i]`.
 * `consumed` is the number of extra argv entries the value used.
 */
export function consumeValue(
  flag: string,
  args: string[],
  i: number
): { value: string; consumed: number } {
  const equalsForm = `${flag}=`;
  const a = args[i];
  if (a === flag) {
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return { value: v, consumed: 1 };
  }
  if (a.startsWith(equalsForm)) {
    const v = a.slice(equalsForm.length);
    if (!v) throw new Error(`${flag} requires a value`);
    return { value: v, consumed: 0 };
  }
  throw new Error(`internal: consumeValue called for non-matching arg ${a}`);
}

/** Error for an option the command does not define. */
export function unknownOption(arg: string, usage: string): Error {
  return new Error(`Unknown option '${arg}'. Usage: ${usage}`);
}

/** Error for a positional the command does not accept. */
export function unexpectedArgument(arg: string, usage: string): Error {
  return new Error(`Unexpected argument '${arg}'. Usage: ${usage}`);
}

/**
 * Walk `args`, handing each option token (starts with `-`) to `onOption`
 * and returning the positionals. `--` ends option parsing. `onOption`
 * returns the number of extra argv entries it consumed, or `undefined`
 * for an option it does not know, which throws.
 */
export function scanArgs(
  args: string[],
  usage: string,
  onOption: (arg: string, i: number) => number | undefined
): string[] {
  const positional: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (optionsEnded || !a.startsWith('-') || a === '-') {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      optionsEnded = true;
      continue;
    }
    const consumed = onOption(a, i);
    if (consumed === undefined) throw unknownOption(a, usage);
    i += consumed;
  }
  return positional;
}

/**
 * `--no-input`. Every command accepts it, so a wrapper can always pass it;
 * on a command that never prompts it changes nothing.
 */
export const NO_INPUT_FLAG = '--no-input';

/** The prompt flags one command parse has seen so far. */
export interface PromptFlagParser {
  /** The `--yes` / `--no-input` state, filled in as options are read. */
  prompt: PromptContext;
  /**
   * A {@link scanArgs} option handler for `--no-input` and, when allowed,
   * `--yes`/`-y`. Returns 0 for a prompt flag, `undefined` otherwise.
   */
  onOption(arg: string): 0 | undefined;
}

/**
 * Shared parsing of the prompt flags for a command that prompts. Pass
 * `allowYes: false` for a command with no confirm, so `--yes` stays an
 * unknown option there.
 */
export function parsePromptFlags(options: {
  allowYes: boolean;
}): PromptFlagParser {
  const prompt: PromptContext = { yes: false, noInput: false };
  return {
    prompt,
    onOption(arg) {
      if (arg === NO_INPUT_FLAG) {
        prompt.noInput = true;
        return 0;
      }
      if (options.allowYes && (arg === '--yes' || arg === '-y')) {
        prompt.yes = true;
        return 0;
      }
      return undefined;
    },
  };
}

/** Parse a plain positive decimal integer, or null. */
export function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

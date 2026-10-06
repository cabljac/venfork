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

/** Parse a plain positive decimal integer, or null. */
export function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

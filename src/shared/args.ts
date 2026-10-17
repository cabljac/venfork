import { UsageError } from '../errors.js';
import { JSON_FLAG } from './json-output.js';
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
    if (!v || v.startsWith('--'))
      throw new UsageError(`${flag} requires a value`);
    return { value: v, consumed: 1 };
  }
  if (a.startsWith(equalsForm)) {
    const v = a.slice(equalsForm.length);
    if (!v) throw new UsageError(`${flag} requires a value`);
    return { value: v, consumed: 0 };
  }
  throw new Error(`internal: consumeValue called for non-matching arg ${a}`);
}

/** Error for an option the command does not define. */
export function unknownOption(arg: string, usage: string): UsageError {
  return new UsageError(`Unknown option '${arg}'. Usage: ${usage}`);
}

/** Error for a positional the command does not accept. */
export function unexpectedArgument(arg: string, usage: string): UsageError {
  return new UsageError(`Unexpected argument '${arg}'. Usage: ${usage}`);
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
  /** Whether `--json` was seen (only with `allowJson`). */
  readonly json: boolean;
  /**
   * A {@link scanArgs} option handler for `--no-input` and, when allowed,
   * `--yes`/`-y` and `--json`. Returns 0 for one of those flags,
   * `undefined` otherwise.
   */
  onOption(arg: string): 0 | undefined;
}

/**
 * Shared parsing of the prompt flags for a command that prompts. Pass
 * `allowYes: false` for a command with no confirm, so `--yes` stays an
 * unknown option there. With `allowJson`, `--json` is accepted and sets
 * `noInput`, so a JSON run never prompts.
 */
export function parsePromptFlags(options: {
  allowYes: boolean;
  allowJson?: boolean;
}): PromptFlagParser {
  const prompt: PromptContext = { yes: false, noInput: false };
  let json = false;
  return {
    prompt,
    get json() {
      return json;
    },
    onOption(arg) {
      if (arg === NO_INPUT_FLAG) {
        prompt.noInput = true;
        return 0;
      }
      if (options.allowYes && (arg === '--yes' || arg === '-y')) {
        prompt.yes = true;
        return 0;
      }
      if (options.allowJson && arg === JSON_FLAG) {
        json = true;
        prompt.noInput = true;
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

/** A parsed `<number-or-url>` argument. */
export interface GitHubRef {
  number: number;
  /** `owner/repo` from the URL form; absent for a bare number. */
  repoPath?: string;
}

/**
 * Parse a `<number-or-url>` argument: a positive integer, or a github.com
 * URL to `<owner>/<repo>/<segment>/<n>`. Throws {@link UsageError} for
 * anything else.
 */
export function parseGitHubRef(
  value: string,
  segment: 'pull' | 'issues'
): GitHubRef {
  const trimmed = value.trim();
  const bare = parsePositiveInt(trimmed);
  if (bare !== null) return { number: bare };
  const match = trimmed.match(
    new RegExp(
      `^(?:https?:\\/\\/(?:www\\.)?|git@)github\\.com[/:]([^/]+\\/[^/]+?)(?:\\.git)?\\/${segment}\\/(\\d+)(?=[/?#]|$)`,
      'i'
    )
  );
  const number = match ? parsePositiveInt(match[2]) : null;
  if (!match || number === null) {
    const kind = segment === 'pull' ? 'PR' : 'issue';
    throw new UsageError(
      `Could not parse ${kind} reference: ${value}. Expected a positive integer or a github.com/<owner>/<repo>/${segment}/<n> URL.`
    );
  }
  return { number, repoPath: match[1] };
}

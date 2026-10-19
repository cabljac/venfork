import {
  CommandExitError,
  type ErrorCode,
  MissingInputError,
  VenforkError,
} from '../errors.js';

/** The `schemaVersion` of every `--json` envelope. */
export const JSON_SCHEMA_VERSION = 1;

/** The flag that asks a command for the JSON envelope on stdout. */
export const JSON_FLAG = '--json';

/** The `error` member of a failure envelope. */
export interface JsonError {
  code: ErrorCode;
  message: string;
  /** The flag that supplies the missing answer; only for `missing-input`. */
  flag?: string;
  /** The next step, often a command to run. */
  hint?: string;
  /** Facts about the failure, such as the files or branch involved. */
  details?: Record<string, unknown>;
}

/** The one JSON object a `--json` run prints on stdout. */
export type JsonEnvelope<T = unknown> =
  | { schemaVersion: typeof JSON_SCHEMA_VERSION; ok: true; result: T }
  | { schemaVersion: typeof JSON_SCHEMA_VERSION; ok: false; error: JsonError };

/**
 * True when `venfork <command> <args>` asked for JSON output: {@link
 * JSON_FLAG} appears anywhere before `--`, the command word included.
 * Scans without parsing, so an unknown command, a misplaced flag or any
 * other usage error in the same argv still gets the envelope.
 */
export function jsonRequested(command: string, args: string[]): boolean {
  const words = [command, ...args];
  const end = words.indexOf('--');
  return (end === -1 ? words : words.slice(0, end)).includes(JSON_FLAG);
}

/** The success envelope for `result`. */
export function successEnvelope<T>(result: T): JsonEnvelope<T> {
  return { schemaVersion: JSON_SCHEMA_VERSION, ok: true, result };
}

/**
 * The failure envelope for `error`. A {@link CommandExitError} that carries
 * a cause describes the cause. A failed `git` or `gh` subprocess is `git` or
 * `github`; any other non-venfork error is `internal`.
 */
export function errorEnvelope(error: unknown): JsonEnvelope<never> {
  const described =
    error instanceof CommandExitError && error.cause !== undefined
      ? error.cause
      : error;
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: false,
    error: describeError(described),
  };
}

/** The command line of a failed execa subprocess, or undefined. */
function failedCommand(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { command, shortMessage } = error as {
    command?: unknown;
    shortMessage?: unknown;
  };
  return typeof command === 'string' && typeof shortMessage === 'string'
    ? command
    : undefined;
}

function describeError(error: unknown): JsonError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof VenforkError) {
    return {
      code: error.code,
      message,
      ...(error instanceof MissingInputError ? { flag: error.flag } : {}),
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const command = failedCommand(error);
  if (command?.startsWith('git ')) return { code: 'git', message };
  if (command?.startsWith('gh ')) return { code: 'github', message };
  return { code: 'internal', message };
}

/**
 * Writes `envelope` to `out` as one line of JSON and a newline. Resolves
 * once the write is flushed, so a following `process.exit` cannot cut it.
 */
export function writeEnvelope(
  envelope: JsonEnvelope,
  out: Pick<NodeJS.WritableStream, 'write'> = process.stdout
): Promise<void> {
  return new Promise((resolve) => {
    out.write(`${JSON.stringify(envelope)}\n`, () => resolve());
  });
}

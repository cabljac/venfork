/**
 * Stable machine-readable error codes, reported as `error.code` in the
 * `--json` envelope. A non-venfork error reports `internal`.
 */
export type ErrorCode =
  | 'runtime'
  | 'internal'
  | 'auth'
  | 'git'
  | 'github'
  | 'precondition'
  | 'remote-not-found'
  | 'not-in-repository'
  | 'branch-not-found'
  | 'sync-divergence'
  | 'config'
  | 'redaction'
  | 'mirror-reference'
  | 'stage-leak'
  | 'pin-downgrade'
  | 'unmigrated-mirror'
  | 'cancelled'
  | 'missing-input'
  | 'usage';

/**
 * Base error class for all Venfork errors
 */
export class VenforkError extends Error {
  /** The stable code `--json` reports for this error. */
  readonly code: ErrorCode;
  /** The next step, printed after the message and reported as `error.hint`. */
  readonly hint?: string;
  /** Facts a script can act on, reported as `error.details`. */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode = 'runtime',
    extra: { hint?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'VenforkError';
    this.code = code;
    if (extra.hint !== undefined) this.hint = extra.hint;
    if (extra.details !== undefined) this.details = extra.details;
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when the GitHub CLI is not authenticated, or with `missing` when
 * no `gh` is on PATH at all.
 */
export class AuthenticationError extends VenforkError {
  constructor(reason: 'unauthenticated' | 'missing' = 'unauthenticated') {
    super(
      reason === 'missing'
        ? 'GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com, then run: gh auth login'
        : 'GitHub CLI is not authenticated. Please run: gh auth login',
      'auth'
    );
    this.name = 'AuthenticationError';
  }
}

/**
 * Thrown when a git operation fails
 */
export class GitError extends VenforkError {
  constructor(
    message: string,
    public readonly operation: string
  ) {
    super(`Git operation failed: ${message}`, 'git');
    this.name = 'GitError';
  }
}

/**
 * Thrown when a required git remote is not found
 */
export class RemoteNotFoundError extends VenforkError {
  constructor(public readonly remoteName: string) {
    super(
      `Remote '${remoteName}' not found. Did you run venfork setup?`,
      'remote-not-found',
      { details: { remote: remoteName } }
    );
    this.name = 'RemoteNotFoundError';
  }
}

/**
 * Thrown when not in a git repository
 */
export class NotInRepositoryError extends VenforkError {
  constructor() {
    super(
      'Not in a git repository. Run this command from inside a git repository.',
      'not-in-repository'
    );
    this.name = 'NotInRepositoryError';
  }
}

/**
 * Thrown when a `gh` call fails; the message is gh's own error output.
 */
export class GitHubError extends VenforkError {
  constructor(message: string) {
    super(message, 'github');
    this.name = 'GitHubError';
  }
}

/**
 * Thrown when the state on GitHub, on disk or in `venfork-config` does not
 * allow the requested action, for example an existing directory or repo
 * that is not the expected one, or a flag that contradicts the recorded
 * layout.
 */
export class PreconditionError extends VenforkError {
  constructor(
    message: string,
    extra: { hint?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message, 'precondition', extra);
    this.name = 'PreconditionError';
  }
}

/**
 * Thrown when a git branch doesn't exist
 */
export class BranchNotFoundError extends VenforkError {
  constructor(public readonly branchName: string) {
    super(`Branch '${branchName}' does not exist`, 'branch-not-found', {
      hint: 'Run `git branch` to list local branches.',
      details: { branch: branchName },
    });
    this.name = 'BranchNotFoundError';
  }
}

/** Divergent commits on one remote's default branch. */
export interface RemoteDivergence {
  count: number;
  files: string[];
}

/**
 * Thrown when sync refuses to run because origin or public carries commits
 * that upstream does not have.
 */
export class SyncDivergenceError extends VenforkError {
  constructor(
    public readonly defaultBranch: string,
    public readonly origin: RemoteDivergence,
    public readonly publicFork: RemoteDivergence,
    /** `venfork preserve add <files>` for the origin files it can keep. */
    preserveCommand?: string
  ) {
    const parts: string[] = [];
    if (origin.count > 0) {
      parts.push(`origin/${defaultBranch} has ${origin.count}`);
    }
    if (publicFork.count > 0) {
      parts.push(`public/${defaultBranch} has ${publicFork.count}`);
    }
    super(
      `Sync aborted to prevent data loss: ${parts.join(', ')} commit(s) not in upstream/${defaultBranch}${listFiles([...origin.files, ...publicFork.files])}.`,
      'sync-divergence',
      {
        hint: preserveCommand
          ? `If the files belong only on the mirror, run \`${preserveCommand}\`. Otherwise move the commits to a branch and retry.`
          : 'Move the commits to a branch and retry. `venfork doctor` shows the divergence.',
        details: {
          branch: defaultBranch,
          origin,
          public: publicFork,
          ...(preserveCommand ? { command: preserveCommand } : {}),
        },
      }
    );
    this.name = 'SyncDivergenceError';
  }
}

/** ` (a, b, and 3 more)` for the first files of a list, or `` for none. */
function listFiles(files: string[]): string {
  const unique = [...new Set(files)];
  if (unique.length === 0) return '';
  const shown = unique.slice(0, 3).join(', ');
  const more = unique.length > 3 ? `, and ${unique.length - 3} more` : '';
  return ` (${shown}${more})`;
}

/** Why a {@link ConfigError} was thrown. */
export type ConfigErrorReason =
  | 'fetch'
  | 'invalid'
  | 'exists'
  | 'conflict'
  | 'missing';

/**
 * Thrown when the `venfork-config` branch exists but cannot be fetched,
 * parsed or validated. Commands must stop rather than treat the mirror as
 * having no config.
 */
export class ConfigError extends VenforkError {
  /**
   * `'fetch'` when origin could not be read, `'invalid'` for bad content,
   * `'exists'` when a create found the branch already there, `'conflict'`
   * when a leased write found the branch moved since it was read,
   * `'missing'` when origin has no `venfork-config` branch.
   */
  public readonly reason: ConfigErrorReason;

  constructor(
    message: string,
    options?: { cause?: unknown; reason?: ConfigErrorReason }
  ) {
    const reason = options?.reason ?? 'invalid';
    super(message, 'config', { details: { reason } });
    this.name = 'ConfigError';
    this.reason = reason;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Thrown when internal-block redaction cannot prove a body is safe to
 * publish: an unmatched close marker, a comment that mentions venfork but is
 * not a marker, or any venfork mention left after stripping.
 */
export class RedactionError extends VenforkError {
  constructor(public readonly snippet: string) {
    super(
      `Refusing to publish: '${snippet}' mentions venfork outside a well-formed <!-- venfork:internal --> ... <!-- /venfork:internal --> block. Fix the markers or remove the mention and retry.`,
      'redaction',
      { details: { snippet } }
    );
    this.name = 'RedactionError';
  }
}

/**
 * Thrown when text bound for the public fork or upstream (a commit's
 * author, committer or message, or a PR title or body) points back at the
 * private mirror.
 */
export class MirrorReferenceError extends VenforkError {
  constructor(
    public readonly where: string,
    public readonly matched: string,
    remedy: string
  ) {
    super(
      `Refusing to publish: ${where} contains '${matched}', which points back at the private mirror. ${remedy}`,
      'mirror-reference',
      { details: { where, matched } }
    );
    this.name = 'MirrorReferenceError';
  }
}

/**
 * Thrown when `venfork stage` would push mirror-only paths (the managed
 * sync workflow, `.venfork/` or preserved files) or mirror-held content to
 * the public fork or upstream.
 */
export class StageLeakError extends VenforkError {
  constructor(
    public readonly branch: string,
    public readonly paths: string[],
    public readonly commit?: string,
    public readonly leak: 'path' | 'content' = 'path'
  ) {
    const who = commit ? `commit ${commit}` : 'it';
    super(
      leak === 'content'
        ? `Refusing to stage '${branch}': ${who} would publish content of a mirror-only file: ${paths.join(', ')}. Rewrite the branch so no commit copies mirror-only content (it belongs on the mirror default branch only) and retry.`
        : `Refusing to stage '${branch}': ${who} would publish mirror-only path(s) ${paths.join(', ')}. Rewrite the branch so no commit adds or changes them (they belong on the mirror default branch only) and retry.`,
      'stage-leak',
      { details: { branch, paths, leak, ...(commit ? { commit } : {}) } }
    );
    this.name = 'StageLeakError';
  }
}

/**
 * Thrown when the sync workflow on origin pins a newer venfork than the
 * running CLI, so an older CLI never rewrites a newer pin.
 */
export class PinDowngradeError extends VenforkError {
  constructor(
    public readonly pinned: string,
    public readonly running: string
  ) {
    super(
      `origin pins venfork ${pinned}, you are running ${running}; upgrade the CLI or set VENFORK_INSTALL_SPEC`,
      'pin-downgrade',
      { details: { pinned, running } }
    );
    this.name = 'PinDowngradeError';
  }
}

/** The steps that migrate a mirror whose sync workflow predates venfork 0.11. */
export const UNMIGRATED_MIRROR_STEPS =
  'Set VENFORK_PUSH_TOKEN, then run `venfork sync` locally once with venfork 0.11 or later; see the README section on upgrading from 0.10.';

/**
 * Thrown by a scheduled run when origin's sync workflow predates the pinned
 * install: the mirror has not been migrated to venfork 0.11 by a local sync.
 */
export class UnmigratedMirrorError extends VenforkError {
  constructor() {
    super(
      `This mirror's sync workflow is not pinned to a venfork version, so it predates venfork 0.11. ${UNMIGRATED_MIRROR_STEPS}`,
      'unmigrated-mirror'
    );
    this.name = 'UnmigratedMirrorError';
  }
}

/**
 * The code for a {@link CommandExitError} that carries no cause: a decline
 * at a confirm (exit 0) or a signal is `cancelled`.
 */
function exitCodeErrorCode(exitCode: number): ErrorCode {
  if (exitCode === 0 || exitCode === 130 || exitCode === 143) {
    return 'cancelled';
  }
  return exitCode === 2 ? 'usage' : 'runtime';
}

/**
 * Thrown by a command that has already printed its outcome. `src/index.ts`
 * exits with `exitCode` and prints nothing more; with `--json` the error
 * envelope describes `cause` when it is set.
 */
export class CommandExitError extends VenforkError {
  constructor(
    public readonly exitCode: number,
    cause?: unknown
  ) {
    super(`Command exited with code ${exitCode}`, exitCodeErrorCode(exitCode));
    this.name = 'CommandExitError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Thrown when a value or a consent is needed but venfork cannot prompt for
 * it (see `canPrompt` in src/shared/prompt.ts). `src/index.ts` exits 2.
 */
export class MissingInputError extends VenforkError {
  constructor(
    /** The flag or argument that supplies the answer, e.g. `--yes`. */
    public readonly flag: string,
    /** The question that could not be asked. */
    public readonly question: string,
    /** What did not happen, e.g. `Not staged.`; starts the message. */
    stopped?: string
  ) {
    const next = flag === '--yes' ? 'Add --yes to confirm.' : `Pass ${flag}.`;
    super(
      `${stopped ? `${stopped} ` : ''}"${question}" needs an answer and venfork cannot prompt here. ${next}`,
      'missing-input',
      { details: { flag, question } }
    );
    this.name = 'MissingInputError';
  }
}

/**
 * Thrown for a usage error: an unknown command or option, a missing or
 * unexpected argument, a malformed flag value, or flags that cannot be
 * combined. `src/index.ts` exits 2.
 */
export class UsageError extends VenforkError {
  constructor(message: string) {
    super(message, 'usage');
    this.name = 'UsageError';
  }
}

/**
 * True for an error a command's catch block rethrows unchanged, because
 * `src/index.ts` reports it and picks its exit code (2, or the code a
 * {@link CommandExitError} carries).
 */
export function isEntryReported(error: unknown): boolean {
  return (
    error instanceof CommandExitError ||
    error instanceof UsageError ||
    error instanceof MissingInputError
  );
}

/** The process exit code for an error that reached `src/index.ts`. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof CommandExitError) return error.exitCode;
  if (error instanceof UsageError || error instanceof MissingInputError) {
    return 2;
  }
  return 1;
}

/**
 * The one human line for `error`: its message, then its hint when it is a
 * {@link VenforkError} with one.
 */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof VenforkError) || !error.hint) return message;
  return `${message}${/[.!?]$/.test(message) ? '' : '.'} ${error.hint}`;
}

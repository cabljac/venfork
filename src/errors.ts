/**
 * Base error class for all Venfork errors
 */
export class VenforkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenforkError';
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when GitHub CLI is not authenticated
 */
export class AuthenticationError extends VenforkError {
  constructor() {
    super('GitHub CLI is not authenticated. Please run: gh auth login');
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
    super(`Git operation failed: ${message}`);
    this.name = 'GitError';
  }
}

/**
 * Thrown when a required git remote is not found
 */
export class RemoteNotFoundError extends VenforkError {
  constructor(public readonly remoteName: string) {
    super(`Remote '${remoteName}' not found. Did you run venfork setup?`);
    this.name = 'RemoteNotFoundError';
  }
}

/**
 * Thrown when not in a git repository
 */
export class NotInRepositoryError extends VenforkError {
  constructor() {
    super(
      'Not in a git repository. Run this command from inside a git repository.'
    );
    this.name = 'NotInRepositoryError';
  }
}

/**
 * Thrown when a git branch doesn't exist
 */
export class BranchNotFoundError extends VenforkError {
  constructor(public readonly branchName: string) {
    super(`Branch '${branchName}' does not exist`);
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
    public readonly publicFork: RemoteDivergence
  ) {
    const parts: string[] = [];
    if (origin.count > 0) {
      parts.push(`origin/${defaultBranch} has ${origin.count}`);
    }
    if (publicFork.count > 0) {
      parts.push(`public/${defaultBranch} has ${publicFork.count}`);
    }
    super(
      `Sync aborted to prevent data loss: ${parts.join(', ')} commit(s) not in upstream/${defaultBranch}`
    );
    this.name = 'SyncDivergenceError';
  }
}

/** Why a {@link ConfigError} was thrown. */
export type ConfigErrorReason = 'fetch' | 'invalid' | 'exists' | 'conflict';

/**
 * Thrown when the `venfork-config` branch exists but cannot be fetched,
 * parsed or validated. Commands must stop rather than treat the mirror as
 * having no config.
 */
export class ConfigError extends VenforkError {
  /**
   * `'fetch'` when origin could not be read, `'invalid'` for bad content,
   * `'exists'` when a create found the branch already there, `'conflict'`
   * when a leased write found the branch moved since it was read.
   */
  public readonly reason: ConfigErrorReason;

  constructor(
    message: string,
    options?: { cause?: unknown; reason?: ConfigErrorReason }
  ) {
    super(message);
    this.name = 'ConfigError';
    this.reason = options?.reason ?? 'invalid';
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
      `Refusing to publish: '${snippet}' mentions venfork outside a well-formed <!-- venfork:internal --> ... <!-- /venfork:internal --> block. Fix the markers or remove the mention and retry.`
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
      `Refusing to publish: ${where} contains '${matched}', which points back at the private mirror. ${remedy}`
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
        : `Refusing to stage '${branch}': ${who} would publish mirror-only path(s) ${paths.join(', ')}. Rewrite the branch so no commit adds or changes them (they belong on the mirror default branch only) and retry.`
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
      `origin pins venfork ${pinned}, you are running ${running}; upgrade the CLI or set VENFORK_INSTALL_SPEC`
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
      `This mirror's sync workflow is not pinned to a venfork version, so it predates venfork 0.11. ${UNMIGRATED_MIRROR_STEPS}`
    );
    this.name = 'UnmigratedMirrorError';
  }
}

/**
 * Thrown by a command that has already printed its outcome. `src/index.ts`
 * exits with `exitCode` and prints nothing more.
 */
export class CommandExitError extends VenforkError {
  constructor(public readonly exitCode: number) {
    super(`Command exited with code ${exitCode}`);
    this.name = 'CommandExitError';
  }
}

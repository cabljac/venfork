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

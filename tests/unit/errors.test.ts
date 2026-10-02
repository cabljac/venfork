import { describe, expect, test } from 'bun:test';
import {
  AuthenticationError,
  BranchNotFoundError,
  GitError,
  NotInRepositoryError,
  RemoteNotFoundError,
  SyncDivergenceError,
  VenforkError,
} from '../../src/errors';

describe('VenforkError', () => {
  test('creates error with correct message', () => {
    const error = new VenforkError('test message');
    expect(error.message).toBe('test message');
    expect(error.name).toBe('VenforkError');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof VenforkError).toBe(true);
  });
});

describe('AuthenticationError', () => {
  test('creates error with correct message and name', () => {
    const error = new AuthenticationError();
    expect(error.message).toBe(
      'GitHub CLI is not authenticated. Please run: gh auth login'
    );
    expect(error.name).toBe('AuthenticationError');
    expect(error instanceof VenforkError).toBe(true);
  });
});

describe('GitError', () => {
  test('creates error with correct message and operation', () => {
    const error = new GitError('fetch failed', 'fetch');
    expect(error.message).toBe('Git operation failed: fetch failed');
    expect(error.name).toBe('GitError');
    expect(error.operation).toBe('fetch');
    expect(error instanceof VenforkError).toBe(true);
  });
});

describe('RemoteNotFoundError', () => {
  test('creates error with correct message and remote name', () => {
    const error = new RemoteNotFoundError('public');
    expect(error.message).toBe(
      "Remote 'public' not found. Did you run venfork setup?"
    );
    expect(error.name).toBe('RemoteNotFoundError');
    expect(error.remoteName).toBe('public');
    expect(error instanceof VenforkError).toBe(true);
  });
});

describe('NotInRepositoryError', () => {
  test('creates error with correct message and name', () => {
    const error = new NotInRepositoryError();
    expect(error.message).toBe(
      'Not in a git repository. Run this command from inside a git repository.'
    );
    expect(error.name).toBe('NotInRepositoryError');
    expect(error instanceof VenforkError).toBe(true);
  });
});

describe('BranchNotFoundError', () => {
  test('creates error with correct message and branch name', () => {
    const error = new BranchNotFoundError('feature-branch');
    expect(error.message).toBe("Branch 'feature-branch' does not exist");
    expect(error.name).toBe('BranchNotFoundError');
    expect(error.branchName).toBe('feature-branch');
    expect(error instanceof VenforkError).toBe(true);
  });
});

describe('SyncDivergenceError', () => {
  test('names each diverged remote and keeps the counts', () => {
    const origin = { count: 2, files: ['a.ts', 'b.ts'] };
    const publicFork = { count: 1, files: ['c.ts'] };
    const error = new SyncDivergenceError('main', origin, publicFork);
    expect(error.message).toBe(
      'Sync aborted to prevent data loss: origin/main has 2, public/main has 1 commit(s) not in upstream/main'
    );
    expect(error.name).toBe('SyncDivergenceError');
    expect(error.origin).toEqual(origin);
    expect(error.publicFork).toEqual(publicFork);
    expect(error instanceof VenforkError).toBe(true);
  });

  test('omits a remote with no divergence', () => {
    const error = new SyncDivergenceError(
      'main',
      { count: 1, files: ['a.ts'] },
      { count: 0, files: [] }
    );
    expect(error.message).toBe(
      'Sync aborted to prevent data loss: origin/main has 1 commit(s) not in upstream/main'
    );
  });
});

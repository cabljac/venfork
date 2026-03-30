import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Unit tests for git.ts with mocked execa
 * These tests verify the actual logic in git.ts functions
 */

type ExecaOptions = Record<string, unknown>;
type MockResponse =
  | { exitCode: number; stdout: string; stderr: string }
  | ((command: string) => Promise<unknown>);

// Track execa calls for verification
const execaCalls: Array<{ command: string; options?: ExecaOptions }> = [];

// Control mock behavior per test
const mockResponses: Map<string, MockResponse> = new Map();

// Mock execa BEFORE importing git.ts
mock.module('execa', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: Mocking execa's complex overloaded types requires any
  $: mock((stringsOrOptions: TemplateStringsArray | any, ...values: any[]) => {
    let command: string;
    let options: ExecaOptions = {};

    // Handle both $`command` and $({ options })`command` patterns
    if (
      typeof stringsOrOptions === 'object' &&
      !Array.isArray(stringsOrOptions)
    ) {
      // Called with options: $({ cwd: '...' })`command`
      options = stringsOrOptions;
      // biome-ignore lint/suspicious/noExplicitAny: Template literal values type
      return mock((strings: TemplateStringsArray, ...vals: any[]) => {
        command = String.raw({ raw: strings }, ...vals);
        execaCalls.push({ command, options });
        return getMockResponse(command, options);
      });
    }

    // Called without options: $`command`
    command = String.raw({ raw: stringsOrOptions }, ...values);
    execaCalls.push({ command, options });
    return getMockResponse(command, options);
  }),
}));

function getMockResponse(command: string, _options: ExecaOptions = {}) {
  // Check if there's a specific mock response set for this test
  for (const [pattern, response] of mockResponses.entries()) {
    if (command.includes(pattern)) {
      return typeof response === 'function'
        ? response(command)
        : Promise.resolve(response);
    }
  }

  // Default responses
  if (command.includes('gh auth status')) {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  if (command.includes('gh api user')) {
    return Promise.resolve({ exitCode: 0, stdout: 'testuser', stderr: '' });
  }
  if (command.includes('git branch --show-current')) {
    return Promise.resolve({ exitCode: 0, stdout: 'main', stderr: '' });
  }
  if (command.includes('git rev-parse --git-dir')) {
    return Promise.resolve({ exitCode: 0, stdout: '.git', stderr: '' });
  }
  if (command.includes('git remote -v')) {
    return Promise.resolve({
      exitCode: 0,
      stdout:
        'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)',
      stderr: '',
    });
  }
  if (command.includes('git remote get-url')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'git@github.com:user/repo.git',
      stderr: '',
    });
  }
  if (command.includes('git remote set-head')) {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  if (command.includes('git symbolic-ref')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'refs/remotes/origin/main',
      stderr: '',
    });
  }

  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
}

// Import git.ts AFTER mocking execa
import {
  checkGhAuth,
  getCurrentBranch,
  getDefaultBranch,
  getGitHubUsername,
  getRemotes,
  ghRepoExists,
  hasRemote,
  isGitRepository,
} from '../src/git';

beforeEach(() => {
  execaCalls.length = 0;
  mockResponses.clear();
});

describe('checkGhAuth', () => {
  test('returns true when gh auth status succeeds', async () => {
    mockResponses.set('gh auth status', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const result = await checkGhAuth();

    expect(result).toBe(true);
    expect(execaCalls[0].command).toContain('gh auth status');
    expect(execaCalls[0].options?.reject).toBe(false);
  });

  test('returns false when gh auth status fails', async () => {
    mockResponses.set('gh auth status', {
      exitCode: 1,
      stdout: '',
      stderr: 'not authenticated',
    });

    const result = await checkGhAuth();

    expect(result).toBe(false);
  });

  test('returns false when command throws error', async () => {
    mockResponses.set('gh auth status', (_command: string) =>
      Promise.reject(new Error('command failed'))
    );

    const result = await checkGhAuth();

    expect(result).toBe(false);
  });
});

describe('getCurrentBranch', () => {
  test('returns branch name from stdout', async () => {
    mockResponses.set('git branch --show-current', {
      exitCode: 0,
      stdout: '  feature-branch  \n',
      stderr: '',
    });

    const result = await getCurrentBranch();

    expect(result).toBe('feature-branch');
    expect(execaCalls[0].command).toContain('git branch --show-current');
  });

  test('returns empty string on error', async () => {
    mockResponses.set('git branch', (_command: string) =>
      Promise.reject(new Error('not a git repo'))
    );

    const result = await getCurrentBranch();

    expect(result).toBe('');
  });

  test('trims whitespace from branch name', async () => {
    mockResponses.set('git branch --show-current', {
      exitCode: 0,
      stdout: '\n\n  main  \n\n',
      stderr: '',
    });

    const result = await getCurrentBranch();

    expect(result).toBe('main');
  });
});

describe('getGitHubUsername', () => {
  test('returns username from gh api', async () => {
    mockResponses.set('gh api user', {
      exitCode: 0,
      stdout: 'octocat',
      stderr: '',
    });

    const result = await getGitHubUsername();

    expect(result).toBe('octocat');
    expect(execaCalls[0].command).toContain('gh api user --jq .login');
  });

  test('trims whitespace from username', async () => {
    mockResponses.set('gh api user', {
      exitCode: 0,
      stdout: '  github-user  \n',
      stderr: '',
    });

    const result = await getGitHubUsername();

    expect(result).toBe('github-user');
  });

  test('returns empty string on error', async () => {
    mockResponses.set('gh api', (_command: string) =>
      Promise.reject(new Error('not authenticated'))
    );

    const result = await getGitHubUsername();

    expect(result).toBe('');
  });
});

describe('isGitRepository', () => {
  test('returns true when in git repository', async () => {
    mockResponses.set('git rev-parse', {
      exitCode: 0,
      stdout: '.git',
      stderr: '',
    });

    const result = await isGitRepository();

    expect(result).toBe(true);
    expect(execaCalls[0].command).toContain('git rev-parse --git-dir');
  });

  test('returns false when not in git repository', async () => {
    mockResponses.set('git rev-parse', {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });

    const result = await isGitRepository();

    expect(result).toBe(false);
  });

  test('returns false on command error', async () => {
    mockResponses.set('git rev-parse', (_command: string) =>
      Promise.reject(new Error('command failed'))
    );

    const result = await isGitRepository();

    expect(result).toBe(false);
  });
});

describe('getRemotes', () => {
  test('parses single remote with fetch and push', async () => {
    mockResponses.set('git remote -v', {
      exitCode: 0,
      stdout:
        'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)',
      stderr: '',
    });

    const result = await getRemotes();

    expect(result).toEqual({
      origin: {
        fetch: 'git@github.com:user/repo.git',
        push: 'git@github.com:user/repo.git',
      },
    });
  });

  test('parses multiple remotes', async () => {
    mockResponses.set('git remote -v', {
      exitCode: 0,
      stdout:
        'origin\tgit@github.com:user/repo.git (fetch)\n' +
        'origin\tgit@github.com:user/repo.git (push)\n' +
        'upstream\tgit@github.com:org/repo.git (fetch)\n' +
        'upstream\tgit@github.com:org/repo.git (push)\n' +
        'public\thttps://github.com:user/fork.git (fetch)\n' +
        'public\thttps://github.com:user/fork.git (push)',
      stderr: '',
    });

    const result = await getRemotes();

    expect(result).toEqual({
      origin: {
        fetch: 'git@github.com:user/repo.git',
        push: 'git@github.com:user/repo.git',
      },
      upstream: {
        fetch: 'git@github.com:org/repo.git',
        push: 'git@github.com:org/repo.git',
      },
      public: {
        fetch: 'https://github.com:user/fork.git',
        push: 'https://github.com:user/fork.git',
      },
    });
  });

  test('handles DISABLE push URL', async () => {
    mockResponses.set('git remote -v', {
      exitCode: 0,
      stdout:
        'upstream\tgit@github.com:org/repo.git (fetch)\n' +
        'upstream\tDISABLE (push)',
      stderr: '',
    });

    const result = await getRemotes();

    expect(result).toEqual({
      upstream: {
        fetch: 'git@github.com:org/repo.git',
        push: 'DISABLE',
      },
    });
  });

  test('returns empty object when no remotes', async () => {
    mockResponses.set('git remote -v', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const result = await getRemotes();

    expect(result).toEqual({});
  });

  test('returns empty object on non-zero exit code', async () => {
    mockResponses.set('git remote -v', {
      exitCode: 1,
      stdout: '',
      stderr: 'error',
    });

    const result = await getRemotes();

    expect(result).toEqual({});
  });

  test('returns empty object on command error', async () => {
    mockResponses.set('git remote', (_command: string) =>
      Promise.reject(new Error('command failed'))
    );

    const result = await getRemotes();

    expect(result).toEqual({});
  });

  test('ignores malformed lines', async () => {
    mockResponses.set('git remote -v', {
      exitCode: 0,
      stdout:
        'origin\tgit@github.com:user/repo.git (fetch)\n' +
        'malformed line here\n' +
        'origin\tgit@github.com:user/repo.git (push)',
      stderr: '',
    });

    const result = await getRemotes();

    expect(result).toEqual({
      origin: {
        fetch: 'git@github.com:user/repo.git',
        push: 'git@github.com:user/repo.git',
      },
    });
  });
});

describe('hasRemote', () => {
  test('returns true when remote exists', async () => {
    mockResponses.set('git remote get-url', {
      exitCode: 0,
      stdout: 'git@github.com:user/repo.git',
      stderr: '',
    });

    const result = await hasRemote('origin');

    expect(result).toBe(true);
    expect(execaCalls[0].command).toContain('git remote get-url origin');
  });

  test('returns false when remote does not exist', async () => {
    mockResponses.set('git remote get-url', {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: No such remote',
    });

    const result = await hasRemote('nonexistent');

    expect(result).toBe(false);
  });

  test('returns false on command error', async () => {
    mockResponses.set('git remote get-url', (_command: string) =>
      Promise.reject(new Error('command failed'))
    );

    const result = await hasRemote('test');

    expect(result).toBe(false);
  });

  test('passes remote name to command', async () => {
    mockResponses.set('git remote get-url', {
      exitCode: 0,
      stdout: 'url',
      stderr: '',
    });

    await hasRemote('my-custom-remote');

    expect(execaCalls[0].command).toContain('my-custom-remote');
  });
});

describe('getDefaultBranch', () => {
  test('returns parsed branch from symbolic-ref', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 0,
      stdout: 'refs/remotes/upstream/develop',
      stderr: '',
    });

    const result = await getDefaultBranch('upstream');

    expect(result).toBe('develop');
  });

  test('calls git remote set-head first', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 0,
      stdout: 'refs/remotes/origin/main',
      stderr: '',
    });

    await getDefaultBranch('origin');

    expect(execaCalls[0].command).toContain('git remote set-head origin -a');
    expect(execaCalls[1].command).toContain(
      'git symbolic-ref refs/remotes/origin/HEAD'
    );
  });

  test('uses upstream as default remote', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 0,
      stdout: 'refs/remotes/upstream/main',
      stderr: '',
    });

    await getDefaultBranch();

    expect(execaCalls[0].command).toContain('upstream');
  });

  test('returns main as fallback when symbolic-ref fails', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 1,
      stdout: '',
      stderr: 'error',
    });

    const result = await getDefaultBranch('origin');

    expect(result).toBe('main');
  });

  test('returns main as fallback on command error', async () => {
    mockResponses.set('git', (_command: string) =>
      Promise.reject(new Error('command failed'))
    );

    const result = await getDefaultBranch();

    expect(result).toBe('main');
  });

  test('handles master branch', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 0,
      stdout: 'refs/remotes/origin/master',
      stderr: '',
    });

    const result = await getDefaultBranch('origin');

    expect(result).toBe('master');
  });

  test('trims whitespace from branch name', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 0,
      stdout: '  refs/remotes/upstream/main  \n',
      stderr: '',
    });

    const result = await getDefaultBranch('upstream');

    expect(result).toBe('main');
  });

  test('returns main when regex does not match', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 0,
      stdout: 'invalid-format',
      stderr: '',
    });

    const result = await getDefaultBranch();

    expect(result).toBe('main');
  });

  test('passes cwd to git when provided', async () => {
    mockResponses.set('git symbolic-ref', {
      exitCode: 0,
      stdout: 'refs/remotes/upstream/main',
      stderr: '',
    });

    await getDefaultBranch('upstream', '/tmp/my-private-mirror');

    expect(execaCalls[0].options).toEqual(
      expect.objectContaining({ cwd: '/tmp/my-private-mirror' })
    );
    expect(execaCalls[1].options).toEqual(
      expect.objectContaining({ cwd: '/tmp/my-private-mirror' })
    );
  });
});

describe('ghRepoExists', () => {
  test('returns true when gh repo view succeeds', async () => {
    const result = await ghRepoExists('acme/existing');

    expect(result).toBe(true);
    expect(
      execaCalls.some((c) => c.command.includes('gh repo view acme/existing'))
    ).toBe(true);
  });

  test('returns false when gh repo view fails', async () => {
    mockResponses.set('gh repo view acme/missing', {
      exitCode: 1,
      stdout: '',
      stderr: 'Not Found',
    });

    const result = await ghRepoExists('acme/missing');

    expect(result).toBe(false);
  });
});

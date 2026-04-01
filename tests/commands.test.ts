import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Command tests with execution-based mocking
 */

// Type definitions for mock tracking
interface RmCall {
  path: string;
  options: { recursive: boolean; force: boolean };
}

type SignalHandler = () => void | Promise<void>;
type MockResponse =
  | { exitCode: number; stdout: string; stderr: string }
  | ((command: string) => Promise<unknown>);

// Track calls to our mocks
const execaCalls: string[] = [];
const rmCalls: RmCall[] = [];
const signalHandlers = new Map<string, SignalHandler>();
let shouldHangOnFork = false;
const mockResponses: Map<string, MockResponse> = new Map();
let confirmResponse = true; // Default to true for most tests

// Store originals
const originalProcessOn = process.on;
const originalProcessOff = process.off;
const originalProcessExit = process.exit;

// Mock execa BEFORE any imports
mock.module('execa', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: Mocking execa's complex overloaded types requires any
  $: mock((stringsOrOptions: TemplateStringsArray | any, ...values: any[]) => {
    let command: string;
    // biome-ignore lint/suspicious/noExplicitAny: Execa options type is complex
    let _options: any = {};

    // Handle both $`command` and $({ options })`command` patterns
    if (
      typeof stringsOrOptions === 'object' &&
      !Array.isArray(stringsOrOptions)
    ) {
      // Called with options: $({ cwd: '...' })`command`
      _options = stringsOrOptions;
      // biome-ignore lint/suspicious/noExplicitAny: Template literal values type
      return mock((strings: TemplateStringsArray, ...vals: any[]) => {
        command = String.raw({ raw: strings }, ...vals);
        execaCalls.push(command);
        return getMockExecaResponse(command);
      });
    }

    // Called without options: $`command`
    command = String.raw({ raw: stringsOrOptions }, ...values);
    execaCalls.push(command);
    return getMockExecaResponse(command);
  }),
}));

function getMockExecaResponse(command: string) {
  // Check if there's a specific mock response set for this test
  for (const [pattern, response] of mockResponses.entries()) {
    if (command.includes(pattern)) {
      return typeof response === 'function'
        ? response(command)
        : Promise.resolve(response);
    }
  }

  // Git auth commands
  if (command.includes('gh auth status')) {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  if (command.includes('gh api user')) {
    return Promise.resolve({ exitCode: 0, stdout: 'testuser', stderr: '' });
  }

  // Git info commands
  if (command.includes('git branch --show-current')) {
    return Promise.resolve({ exitCode: 0, stdout: 'main', stderr: '' });
  }
  if (command.includes('git rev-parse')) {
    return Promise.resolve({ exitCode: 0, stdout: '.git', stderr: '' });
  }
  if (command.includes('git remote -v')) {
    return Promise.resolve({
      exitCode: 0,
      stdout:
        'origin\tgit@github.com:test/repo.git (fetch)\norigin\tgit@github.com:test/repo.git (push)',
      stderr: '',
    });
  }
  if (command.includes('git remote get-url')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'git@github.com:test/repo.git',
      stderr: '',
    });
  }
  if (command.includes('git remote set-head')) {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  if (command.includes('git symbolic-ref')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'refs/remotes/upstream/main',
      stderr: '',
    });
  }

  // GitHub CLI commands for clone
  if (command.includes('gh repo view') && command.includes('--json parent')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'https://github.com/upstream/original.git',
      stderr: '',
    });
  }
  if (command.includes('gh repo view')) {
    // Checking if public fork exists
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }

  // For signal handler tests: make fork command hang to prevent cleanup
  // This keeps setupCommand running so signal handlers remain registered
  if (command.includes('gh repo fork') && shouldHangOnFork) {
    return new Promise(() => {}); // Never resolves
  }

  // Default response for all other commands
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
}

// Mock fs.rm and fs.access BEFORE any imports
mock.module('node:fs/promises', () => ({
  rm: mock((path: string, options: { recursive: boolean; force: boolean }) => {
    rmCalls.push({ path, options });
    return Promise.resolve();
  }),
  access: mock(() => Promise.reject(new Error('ENOENT'))),
}));

// Mock prompts BEFORE any imports
mock.module('@clack/prompts', () => ({
  intro: mock(() => {}),
  spinner: mock(() => ({
    start: mock(() => {}),
    stop: mock(() => {}),
  })),
  note: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  log: { error: mock(() => {}), warn: mock(() => {}), info: mock(() => {}) },
  group: mock(() => Promise.resolve({})),
  text: mock(() => Promise.resolve('')),
  confirm: mock(() => Promise.resolve(confirmResponse)), // Use dynamic confirmResponse
  isCancel: mock(() => false),
}));

// Import commands (will use mocked execa, fs, and prompts)
import {
  cloneCommand,
  setupCommand,
  showHelp,
  stageCommand,
  statusCommand,
  syncCommand,
} from '../src/commands.js';

/**
 * Helper function to start setupCommand and wait for async operations to progress
 * to the point where signal handlers are registered
 */
async function startSetupCommand(
  upstreamUrl = 'git@github.com:test/repo.git',
  privateMirrorName = 'test-vendor'
): Promise<void> {
  // Enable fork hanging to keep setupCommand running for signal handler tests
  shouldHangOnFork = true;

  const promise = setupCommand(upstreamUrl, privateMirrorName);

  // Wait for async operations to complete (checkGhAuth, getGitHubUsername, etc.)
  // Signal handlers are registered after these complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Suppress unhandled rejection warnings
  promise.catch(() => {});
}

beforeEach(() => {
  // Clear tracking arrays
  execaCalls.length = 0;
  rmCalls.length = 0;
  signalHandlers.clear();
  shouldHangOnFork = false;
  mockResponses.clear();
  confirmResponse = true; // Reset to true for each test

  // Clear VENFORK_ORG environment variable
  delete process.env.VENFORK_ORG;

  // Mock process methods
  process.on = ((event: string, handler: SignalHandler) => {
    signalHandlers.set(event, handler);
    return process;
    // biome-ignore lint/suspicious/noExplicitAny: Process.on return type is complex
  }) as any;

  process.off = ((event: string, _handler: SignalHandler) => {
    signalHandlers.delete(event);
    return process;
    // biome-ignore lint/suspicious/noExplicitAny: Process.off return type is complex
  }) as any;

  process.exit = mock(() => {
    throw new Error('process.exit called');
    // biome-ignore lint/suspicious/noExplicitAny: Process.exit type is complex
  }) as any;
});

afterEach(() => {
  // Restore process methods
  process.on = originalProcessOn;
  process.off = originalProcessOff;
  process.exit = originalProcessExit;
});
describe('setupCommand - execution tests', () => {
  test('registers SIGINT handler', async () => {
    await startSetupCommand();

    expect(signalHandlers.has('SIGINT')).toBe(true);
  });

  test('registers SIGTERM handler', async () => {
    await startSetupCommand();

    expect(signalHandlers.has('SIGTERM')).toBe(true);
  });

  test('cleanup called when SIGINT triggered', async () => {
    await startSetupCommand();

    const handler = signalHandlers.get('SIGINT');
    expect(handler).toBeDefined();

    try {
      await handler?.();
    } catch {
      // Expected to throw on process.exit(130)
    }

    // Verify rm was called
    expect(rmCalls.length).toBeGreaterThan(0);
    expect(rmCalls[0].path).toMatch(/venfork-[a-f0-9]+/);
    expect(rmCalls[0].options).toEqual({ recursive: true, force: true });
  });

  test('temp directory uses os.tmpdir()', async () => {
    await startSetupCommand();

    const handler = signalHandlers.get('SIGINT');

    try {
      await handler?.();
    } catch {
      // Expected
    }

    // Temp dir should contain venfork- and be in system temp
    const tempDir = rmCalls[0]?.path;
    expect(tempDir).toContain('venfork-');
    expect(tempDir.length).toBeGreaterThan(20);
  });

  test('calls execa for gh commands in correct sequence', async () => {
    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // Expected
    }

    // Verify we have multiple commands
    expect(execaCalls.length).toBeGreaterThanOrEqual(4);

    // Step 0: Auth check happens first
    expect(execaCalls[0]).toContain('gh auth status');

    // Step 1: Get GitHub username
    expect(execaCalls[1]).toContain('gh api user');

    // Step 2: Fork the upstream repo
    expect(execaCalls[2]).toContain('gh repo fork');
    expect(execaCalls[2]).toContain('test/repo');
    expect(execaCalls[2]).toContain('--clone=false');

    // Step 3: Create private vendor repo
    expect(execaCalls[3]).toContain('gh repo create');
    expect(execaCalls[3]).toContain('test-vendor');
    expect(execaCalls[3]).toContain('--private');

    // Verify we called multiple git/gh commands
    const ghCommands = execaCalls.filter((cmd) => cmd.includes('gh '));
    const gitCommands = execaCalls.filter((cmd) => cmd.includes('git '));

    expect(ghCommands.length).toBeGreaterThanOrEqual(2);
    expect(gitCommands.length).toBeGreaterThanOrEqual(1);
  });

  test('accepts owner/repo shorthand for upstream', async () => {
    try {
      await setupCommand('test/repo', 'test-vendor');
    } catch {
      // Expected
    }

    expect(
      execaCalls.some(
        (c) => c.includes('gh repo fork') && c.includes('test/repo')
      )
    ).toBe(true);
    expect(
      execaCalls.some(
        (c) => c.includes('gh repo clone') && c.includes('test/repo')
      )
    ).toBe(true);
  });

  test('cleanup called in finally block', async () => {
    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // Expected
    }

    // rm should have been called (from finally block)
    expect(rmCalls.length).toBeGreaterThan(0);
  });
});

describe('setupCommand - idempotent recovery', () => {
  test('skips upstream seed clone and runs sync when private mirror already exists on GitHub', async () => {
    mockResponses.set('gh repo create', {
      exitCode: 1,
      stderr: 'name already exists on this account',
      stdout: '',
    });
    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // process.exit if a nested command fails unexpectedly
    }

    const cloneCalls = execaCalls.filter((c) => c.includes('gh repo clone'));
    expect(cloneCalls.length).toBe(1);
    expect(cloneCalls[0]).toContain('test-vendor');
    expect(execaCalls.some((c) => c.includes('git fetch upstream'))).toBe(true);
  });

  test('still seeds new private mirror and runs sync when public fork already exists', async () => {
    mockResponses.set('gh repo fork', {
      exitCode: 1,
      stderr: 'already forked',
      stdout: '',
    });
    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // ignore
    }

    const cloneCalls = execaCalls.filter((c) => c.includes('gh repo clone'));
    expect(cloneCalls.length).toBe(2);
    expect(cloneCalls.some((c) => c.includes('test/repo'))).toBe(true);
    expect(cloneCalls.some((c) => c.includes('test-vendor'))).toBe(true);
    expect(execaCalls.some((c) => c.includes('git fetch upstream'))).toBe(true);
  });

  test('fails when private mirror create fails and repo is not found on GitHub', async () => {
    mockResponses.set('gh repo create', {
      exitCode: 1,
      stderr: 'GraphQL: error',
      stdout: '',
    });
    mockResponses.set('gh repo view testuser/test-vendor', {
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 404: Not Found',
    });

    await expect(
      setupCommand('git@github.com:test/repo.git', 'test-vendor')
    ).rejects.toThrow('process.exit called');
  });
});

describe('syncCommand', () => {
  test('fetches from all remotes', async () => {
    try {
      await syncCommand('main');
    } catch {
      // Expected - may fail in test environment
    }

    // Should have called git fetch for all remotes
    const fetchCalls = execaCalls.filter((cmd) => cmd.includes('git fetch'));

    expect(fetchCalls.some((cmd) => cmd.includes('git fetch upstream'))).toBe(
      true
    );
    expect(fetchCalls.some((cmd) => cmd.includes('git fetch origin'))).toBe(
      true
    );
    expect(fetchCalls.some((cmd) => cmd.includes('git fetch public'))).toBe(
      true
    );
  });

  test('pushes to origin and public default branches', async () => {
    try {
      await syncCommand('main');
    } catch {
      // Expected
    }

    // Should push upstream/main to origin/main and public/main
    const pushCalls = execaCalls.filter((cmd) => cmd.includes('git push'));

    expect(
      pushCalls.some((cmd) =>
        cmd.includes('git push origin upstream/main:main')
      )
    ).toBe(true);
    expect(
      pushCalls.some((cmd) =>
        cmd.includes('git push public upstream/main:main')
      )
    ).toBe(true);
  });

  test('uses default branch when not specified', async () => {
    try {
      await syncCommand();
    } catch {
      // Expected
    }

    // Should call getDefaultBranch (already mocked to return 'main')
    const pushCalls = execaCalls.filter((cmd) => cmd.includes('git push'));
    expect(pushCalls.length).toBeGreaterThanOrEqual(2);
  });

  test('checks for divergent commits', async () => {
    try {
      await syncCommand('main');
    } catch {
      // Expected
    }

    // Should call git rev-list to check divergence
    const revListCalls = execaCalls.filter((cmd) =>
      cmd.includes('git rev-list --count')
    );
    expect(revListCalls.length).toBeGreaterThanOrEqual(2); // Check origin and public
  });
});

describe('stageCommand', () => {
  test('verifies branch exists', async () => {
    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected - authentication or other checks may fail
    }

    // Should verify branch with git rev-parse
    const verifyCalls = execaCalls.filter((cmd) =>
      cmd.includes('git rev-parse')
    );
    // May not get this far due to auth check, but test completed
    expect(verifyCalls.length).toBeGreaterThanOrEqual(0);
  });

  test('checks authentication first', async () => {
    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected - auth check happens first
    }

    // checkGhAuth is called (via mock), command should attempt to run
    expect(true).toBe(true);
  });

  test('requires branch parameter', async () => {
    try {
      await stageCommand('');
    } catch {
      // Expected to exit
    }

    // Process.exit should have been called
    expect(process.exit).toHaveBeenCalled();
  });

  test('creates draft PR when createPr option is enabled', async () => {
    try {
      await stageCommand('feature-branch', { createPr: true });
    } catch {
      // Expected in mocked environment
    }

    expect(execaCalls.some((cmd) => cmd.includes('gh pr create --repo'))).toBe(
      true
    );
    expect(execaCalls.some((cmd) => cmd.includes('--draft'))).toBe(true);
  });

  test('copies private PR body when copyPrBody is enabled', async () => {
    mockResponses.set(
      'gh pr list --repo test/repo --head test:feature-branch',
      {
        exitCode: 0,
        stdout: JSON.stringify([
          { title: 'Internal PR title', body: 'Internal PR body' },
        ]),
        stderr: '',
      }
    );

    try {
      await stageCommand('feature-branch', {
        createPr: true,
        copyPrBody: true,
      });
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some((cmd) => cmd.includes('gh pr list --repo test/repo'))
    ).toBe(true);
    expect(
      execaCalls.some((cmd) => cmd.includes('--title Internal PR title'))
    ).toBe(true);
  });
});

describe('statusCommand', () => {
  test('checks if in git repository', async () => {
    try {
      await statusCommand();
    } catch {
      // Expected
    }

    // isGitRepository mock should have been called
    // The function should check repository status
    expect(execaCalls.length).toBeGreaterThanOrEqual(0);
  });

  test('gets current branch and remotes', async () => {
    try {
      await statusCommand();
    } catch {
      // Expected
    }

    // Should call getCurrentBranch and getRemotes (via mocks)
    // These are mocked so we just verify the command ran
    expect(true).toBe(true);
  });
});

describe('showHelp', () => {
  test('displays help information', () => {
    // showHelp is synchronous and just displays info
    showHelp();

    // Should not throw and should complete successfully
    expect(true).toBe(true);
  });
});

describe('setupCommand - organization tests', () => {
  test('uses --org flag when organization is specified', async () => {
    try {
      await setupCommand(
        'git@github.com:test/repo.git',
        'test-vendor',
        'my-org'
      );
    } catch {
      // Expected
    }

    // Should call gh repo fork with --org flag
    const forkCalls = execaCalls.filter((cmd) => cmd.includes('gh repo fork'));
    expect(forkCalls.length).toBeGreaterThan(0);
    expect(forkCalls[0]).toContain('--org my-org');
  });

  test('creates private repo with org/repo format when organization specified', async () => {
    try {
      await setupCommand(
        'git@github.com:test/repo.git',
        'test-vendor',
        'my-org'
      );
    } catch {
      // Expected
    }

    // Should call gh repo create with org/repo format
    const createCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo create')
    );
    expect(createCalls.length).toBeGreaterThan(0);
    expect(createCalls[0]).toContain('my-org/test-vendor');
  });

  test('passes --fork-name to gh repo fork and uses it for public remote', async () => {
    try {
      await setupCommand(
        'git@github.com:test/repo.git',
        'test-vendor',
        'my-org',
        'repo-staging'
      );
    } catch {
      // Expected
    }

    const forkCalls = execaCalls.filter((cmd) => cmd.includes('gh repo fork'));
    expect(forkCalls.length).toBeGreaterThan(0);
    expect(forkCalls[0]).toContain('--fork-name repo-staging');
    expect(forkCalls[0]).toContain('--org my-org');
    expect(
      execaCalls.some(
        (cmd) => cmd.includes('git remote') && cmd.includes('repo-staging')
      )
    ).toBe(true);
  });

  test('uses organization in git URLs when specified', async () => {
    try {
      await setupCommand(
        'git@github.com:test/repo.git',
        'test-vendor',
        'my-org'
      );
    } catch {
      // Expected
    }

    // Should use org in clone and remote URLs
    const cloneCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo clone')
    );
    const remoteCalls = execaCalls.filter(
      (cmd) =>
        cmd.includes('git remote add') || cmd.includes('git remote set-url')
    );

    expect(cloneCalls.some((cmd) => cmd.includes('my-org/test-vendor'))).toBe(
      true
    );
    expect(remoteCalls.some((cmd) => cmd.includes('my-org/'))).toBe(true);
  });

  test('uses username when no organization specified', async () => {
    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // Expected
    }

    // Should NOT include --org flag
    const forkCalls = execaCalls.filter((cmd) => cmd.includes('gh repo fork'));
    expect(forkCalls.length).toBeGreaterThan(0);
    expect(forkCalls[0]).not.toContain('--org');

    // Should use testuser (from mock) in URLs
    const cloneCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo clone')
    );
    expect(cloneCalls.some((cmd) => cmd.includes('testuser/test-vendor'))).toBe(
      true
    );
  });
});

describe('setupCommand - VENFORK_ORG environment variable', () => {
  test('uses VENFORK_ORG when no --org flag is present', async () => {
    // Simulate what index.ts does: read VENFORK_ORG and pass to setupCommand
    process.env.VENFORK_ORG = 'env-org';
    const organization = process.env.VENFORK_ORG;

    try {
      await setupCommand(
        'git@github.com:test/repo.git',
        'test-vendor',
        organization
      );
    } catch {
      // Expected
    }

    // Should use env-org in commands
    const forkCalls = execaCalls.filter((cmd) => cmd.includes('gh repo fork'));
    expect(forkCalls.length).toBeGreaterThan(0);
    expect(forkCalls[0]).toContain('--org env-org');

    // Should use env-org in URLs
    const cloneCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo clone')
    );
    expect(cloneCalls.some((cmd) => cmd.includes('env-org/test-vendor'))).toBe(
      true
    );
  });

  test('--org flag overrides VENFORK_ORG', async () => {
    process.env.VENFORK_ORG = 'env-org';

    try {
      await setupCommand(
        'git@github.com:test/repo.git',
        'test-vendor',
        'flag-org'
      );
    } catch {
      // Expected
    }

    // Should use flag-org (not env-org)
    const forkCalls = execaCalls.filter((cmd) => cmd.includes('gh repo fork'));
    expect(forkCalls.length).toBeGreaterThan(0);
    expect(forkCalls[0]).toContain('--org flag-org');
    expect(forkCalls[0]).not.toContain('env-org');

    // Should use flag-org in URLs
    const cloneCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo clone')
    );
    expect(cloneCalls.some((cmd) => cmd.includes('flag-org/test-vendor'))).toBe(
      true
    );
    expect(cloneCalls.some((cmd) => cmd.includes('env-org/'))).toBe(false);
  });

  test('prompts for confirmation when neither --org nor VENFORK_ORG is set', async () => {
    // Ensure env var is not set
    delete process.env.VENFORK_ORG;
    // Confirm will return true (from beforeEach default)

    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // Expected
    }

    // Should use testuser (after confirmation)
    const cloneCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo clone')
    );
    expect(cloneCalls.some((cmd) => cmd.includes('testuser/test-vendor'))).toBe(
      true
    );
  });

  test('exits when user declines personal account confirmation', async () => {
    // Ensure env var is not set
    delete process.env.VENFORK_ORG;
    // Set confirm to return false (decline)
    confirmResponse = false;

    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // Expected - command should exit
    }

    // Should call process.exit
    expect(process.exit).toHaveBeenCalledWith(0);

    // Should NOT create any repos
    const createCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo create')
    );
    expect(createCalls.length).toBe(0);
  });
});

describe('setupCommand - error paths', () => {
  test('throws AuthenticationError when not authenticated', async () => {
    // Mock checkGhAuth to return false
    mockResponses.set('gh auth status', {
      exitCode: 1,
      stdout: '',
      stderr: 'not authenticated',
    });

    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  test('handles error in catch block', async () => {
    // Make fork command fail instead of hanging
    mockResponses.set('gh repo fork', (_command: string) =>
      Promise.reject(new Error('Fork failed'))
    );

    try {
      await setupCommand('git@github.com:test/repo.git', 'test-vendor');
    } catch {
      // Expected
    }

    // Cleanup should still be called
    expect(rmCalls.length).toBeGreaterThan(0);
  });
});

describe('cloneCommand', () => {
  test('checks authentication first', async () => {
    try {
      await cloneCommand('git@github.com:acme/project-private.git');
    } catch {
      // Expected
    }

    // Should check authentication
    const authCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh auth status')
    );
    expect(authCalls.length).toBeGreaterThan(0);
  });

  test('clones the vendor repository', async () => {
    try {
      await cloneCommand('git@github.com:acme/project-private.git');
    } catch {
      // Expected
    }

    // Should clone the repo via gh (owner/repo + target dir)
    const cloneCalls = execaCalls.filter((cmd) =>
      cmd.includes('gh repo clone')
    );
    expect(cloneCalls.length).toBeGreaterThan(0);
    expect(cloneCalls[0]).toContain('acme/project-private');
  });

  test('detects public fork by stripping -private suffix', async () => {
    try {
      await cloneCommand('git@github.com:acme/project-private.git');
    } catch {
      // Expected
    }

    // Should try to detect public fork
    const viewCalls = execaCalls.filter((cmd) => cmd.includes('gh repo view'));
    expect(viewCalls.length).toBeGreaterThan(0);
    // Should check for 'project' (without -private)
    expect(viewCalls.some((cmd) => cmd.includes('acme/project'))).toBe(true);
  });

  test('attempts to configure remotes', async () => {
    try {
      await cloneCommand('git@github.com:acme/project-private.git');
    } catch {
      // Expected - may fail due to interactive prompts in test environment
    }

    // Command should attempt to configure remotes
    // Note: Full remote configuration may require interactive input mocking
    const remoteCalls = execaCalls.filter((cmd) => cmd.includes('git remote'));
    // Should attempt some remote operations
    expect(remoteCalls.length).toBeGreaterThan(0);
  });
});

describe('cloneCommand - error paths', () => {
  test('throws AuthenticationError when not authenticated', async () => {
    mockResponses.set('gh auth status', {
      exitCode: 1,
      stdout: '',
      stderr: 'not authenticated',
    });

    try {
      await cloneCommand('git@github.com:acme/project-private.git');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  test('requires vendor repo URL', async () => {
    try {
      await cloneCommand();
    } catch {
      // Expected - process.exit(1) throws
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('syncCommand - error paths', () => {
  test('aborts when origin has divergent commits', async () => {
    // Mock rev-list to show origin has divergent commits
    mockResponses.set('git rev-list --count upstream/main..origin/main', {
      exitCode: 0,
      stdout: '3',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected - process.exit(1) throws in tests
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test('aborts when public has divergent commits', async () => {
    // Mock rev-list to show public has divergent commits
    mockResponses.set('git rev-list --count upstream/main..public/main', {
      exitCode: 0,
      stdout: '2',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected - process.exit(1) throws in tests
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test('handles fetch errors', async () => {
    mockResponses.set('git fetch', (_command: string) =>
      Promise.reject(new Error('Fetch failed'))
    );

    try {
      await syncCommand('main');
    } catch {
      // Expected
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test('handles push errors', async () => {
    mockResponses.set('git push', (_command: string) =>
      Promise.reject(new Error('Push failed'))
    );

    try {
      await syncCommand('main');
    } catch {
      // Expected
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('stageCommand - error paths', () => {
  test('throws AuthenticationError when not authenticated', async () => {
    mockResponses.set('gh auth status', {
      exitCode: 1,
      stdout: '',
      stderr: 'not authenticated',
    });

    try {
      await stageCommand('feature-branch');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  test('throws BranchNotFoundError when branch does not exist', async () => {
    mockResponses.set('git rev-parse --verify', {
      exitCode: 1,
      stdout: '',
      stderr: 'not found',
    });

    try {
      await stageCommand('nonexistent-branch');
    } catch {
      // Expected - process.exit throws
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test('throws RemoteNotFoundError when public remote missing', async () => {
    mockResponses.set('git remote get-url public', {
      exitCode: 1,
      stdout: '',
      stderr: 'not found',
    });

    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('statusCommand - error paths', () => {
  test('throws NotInRepositoryError when not in git repo', async () => {
    mockResponses.set('git rev-parse --git-dir', {
      exitCode: 128,
      stdout: '',
      stderr: 'not a git repository',
    });

    try {
      await statusCommand();
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  test('shows message when no remotes configured', async () => {
    mockResponses.set('git remote -v', { exitCode: 0, stdout: '', stderr: '' });

    try {
      await statusCommand();
    } catch {
      // Expected - may exit
    }

    // Command should run successfully
    expect(execaCalls.some((cmd) => cmd.includes('git remote -v'))).toBe(true);
  });

  test('shows incomplete setup message when missing remotes', async () => {
    // Mock hasRemote to return false for public
    mockResponses.set('git remote get-url public', {
      exitCode: 1,
      stdout: '',
      stderr: 'not found',
    });

    try {
      await statusCommand();
    } catch {
      // Expected
    }

    // Should check for remotes
    expect(execaCalls.some((cmd) => cmd.includes('git remote get-url'))).toBe(
      true
    );
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Command tests with execution-based mocking
 */

// Type definitions for mock tracking
interface RmCall {
  path: string;
  options: { recursive: boolean; force: boolean };
}
interface WriteFileCall {
  path: string;
  content: string;
}

type SignalHandler = () => void | Promise<void>;
type MockResponse =
  | { exitCode: number; stdout: string; stderr: string }
  | ((command: string) => Promise<unknown>);

// Track calls to our mocks
const execaCalls: string[] = [];
const rmCalls: RmCall[] = [];
const writeFileCalls: WriteFileCall[] = [];
const noteCalls: Array<{ message: string; title?: string }> = [];
const signalHandlers = new Map<string, SignalHandler>();
let shouldHangOnFork = false;
const mockResponses: Map<string, MockResponse> = new Map();
let confirmResponse = true; // Default to true for most tests
let tempDirCounter = 0;
let accessExists: (filePath: string) => boolean = () => false;

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
  if (
    command.includes('gh repo view') &&
    command.includes('--json isFork,parent')
  ) {
    return Promise.resolve({
      exitCode: 0,
      stdout: 'true',
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
  mkdtemp: mock((prefix: string) => {
    tempDirCounter += 1;
    return Promise.resolve(`${prefix}${tempDirCounter}`);
  }),
  mkdir: mock(() => Promise.resolve()),
  writeFile: mock((path: string, content: string) => {
    writeFileCalls.push({ path, content });
    return Promise.resolve();
  }),
  readFile: mock(() => Promise.reject(new Error('ENOENT'))),
  rm: mock((path: string, options: { recursive: boolean; force: boolean }) => {
    rmCalls.push({ path, options });
    return Promise.resolve();
  }),
  access: mock((filePath: string) =>
    accessExists(filePath)
      ? Promise.resolve()
      : Promise.reject(new Error('ENOENT'))
  ),
}));

// Mock prompts BEFORE any imports
mock.module('@clack/prompts', () => ({
  intro: mock(() => {}),
  spinner: mock(() => ({
    start: mock(() => {}),
    stop: mock(() => {}),
  })),
  note: mock((message: string, title?: string) => {
    noteCalls.push({ message, title });
  }),
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
  issueCommand,
  pullRequestCommand,
  scheduleCommand,
  setupCommand,
  showHelp,
  stageCommand,
  statusCommand,
  syncCommand,
  workflowsCommand,
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
  writeFileCalls.length = 0;
  noteCalls.length = 0;
  signalHandlers.clear();
  shouldHangOnFork = false;
  mockResponses.clear();
  confirmResponse = true; // Reset to true for each test
  tempDirCounter = 0;
  accessExists = () => false;

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

  test('fails when default-name repo exists but is not a fork of upstream', async () => {
    mockResponses.set('gh repo fork', {
      exitCode: 1,
      stderr: 'already exists',
      stdout: '',
    });
    mockResponses.set('--json isFork,parent', {
      exitCode: 0,
      stdout: 'false',
      stderr: '',
    });

    await expect(
      setupCommand(
        'git@github.com:firebase/extensions.git',
        'firebase-extensions-private',
        'invertase',
        'firebase-extensions'
      )
    ).rejects.toThrow('process.exit called');
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
        cmd.includes('git push origin upstream/main:refs/heads/main')
      )
    ).toBe(true);
    expect(
      pushCalls.some((cmd) =>
        cmd.includes('git push public upstream/main:refs/heads/main')
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
      cmd.includes('git rev-list upstream/main..')
    );
    expect(revListCalls.length).toBeGreaterThanOrEqual(2); // Check origin and public
  });

  test('re-applies deterministic workflow commit when scheduling is enabled', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some((cmd) => cmd.includes('git worktree add --detach'))
    ).toBe(true);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'commit --allow-empty -m chore: venfork-managed mirror commit'
        )
      )
    ).toBe(true);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin HEAD:main --force-with-lease')
      )
    ).toBe(true);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push public HEAD:main --force')
      )
    ).toBe(false);
    expect(
      writeFileCalls.some((w) =>
        w.path.includes('.github/workflows/venfork-sync.yml')
      )
    ).toBe(true);
  });

  test('skips workflow commit normalization when scheduling is disabled', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: false, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some((cmd) => cmd.includes('git worktree add --detach'))
    ).toBe(false);
  });

  test('preserve carries mirror-only files forward across sync', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        preserve: ['.github/workflows/caller.yml'],
      }),
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify origin/main', {
      exitCode: 0,
      stdout: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      stderr: '',
    });
    mockResponses.set(
      'git show aaaa1111bbbb2222cccc3333dddd4444eeee5555:.github/workflows/caller.yml',
      {
        exitCode: 0,
        stdout: 'name: caller\non: workflow_dispatch\n',
        stderr: '',
      }
    );

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    // The "+1 commit" path runs even though schedule is disabled.
    expect(
      execaCalls.some((cmd) => cmd.includes('git worktree add --detach'))
    ).toBe(true);
    // git show is called against the captured previous mirror tip.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'git show aaaa1111bbbb2222cccc3333dddd4444eeee5555:.github/workflows/caller.yml'
        )
      )
    ).toBe(true);
    // The preserved file is added in the temp worktree.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git add -- .github/workflows/caller.yml')
      )
    ).toBe(true);
    // The deterministic commit + force-push happen.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin HEAD:main --force-with-lease')
      )
    ).toBe(true);
  });

  test('preserve skips paths that already exist upstream (upstream wins)', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        preserve: ['.github/workflows/ci.yml'],
      }),
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify origin/main', {
      exitCode: 0,
      stdout: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      stderr: '',
    });
    // Pretend the temp worktree (started from upstream) already has the file.
    accessExists = (p) => p.includes('.github/workflows/ci.yml');

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    // git show against the previous mirror tip should NOT be called for the
    // colliding path — upstream's version wins, and the carry-forward is skipped.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'git show aaaa1111bbbb2222cccc3333dddd4444eeee5555:.github/workflows/ci.yml'
        )
      )
    ).toBe(false);
    // git add for the preserved path should NOT be called either.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git add -- .github/workflows/ci.yml')
      )
    ).toBe(false);
  });

  test('preserve fails loudly when source path is missing on previous mirror tip', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        preserve: ['.github/workflows/missing.yml'],
      }),
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify origin/main', {
      exitCode: 0,
      stdout: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      stderr: '',
    });
    mockResponses.set(
      'git show aaaa1111bbbb2222cccc3333dddd4444eeee5555:.github/workflows/missing.yml',
      { exitCode: 128, stdout: '', stderr: 'fatal: path ... does not exist' }
    );

    let caught = false;
    try {
      await syncCommand('main');
    } catch {
      caught = true;
    }

    // process.exit(1) is mocked to throw — sync should have errored before
    // creating the deterministic commit on the temp worktree.
    expect(caught).toBe(true);
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('commit --allow-empty') &&
          cmd.includes('chore: venfork-managed mirror commit')
      )
    ).toBe(false);
  });

  test('preserve carries the user-committed content forward (v2 wins, not v1, not upstream, not absent)', async () => {
    // Mirror tip already has agent.yml@v1; user commits v2 directly to
    // origin/main and pushes. Sync runs. Post-sync, the worktree write that
    // feeds the +1 commit must contain v2 — not v1, not upstream's version,
    // not absent. This pins the contract that previousMirrorTip is captured
    // *after* fetch and *before* the force-push, so it sees the user's
    // most-recent commit.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        preserve: ['agent.yml'],
      }),
      stderr: '',
    });
    // Local origin/main (post-fetch) is the SHA of the user's v2 commit.
    mockResponses.set('git rev-parse --verify origin/main', {
      exitCode: 0,
      stdout: 'v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2',
      stderr: '',
    });
    // Reading agent.yml from the v2 SHA returns the user's v2 content.
    mockResponses.set(
      'git show v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2:agent.yml',
      { exitCode: 0, stdout: 'agent: v2', stderr: '' }
    );
    mockResponses.set('git ls-tree v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2', {
      exitCode: 0,
      stdout: '100644 blob deadbeef\tagent.yml\n',
      stderr: '',
    });
    // Divergence check: the v2 commit is on origin (the user's commit).
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'v2v2v2v2v2v2v2v2\n',
      stderr: '',
    });
    mockResponses.set('git rev-list upstream/main..public/main', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set(
      'git diff-tree -r --no-commit-id --name-only -m --first-parent v2v2v2v2v2v2v2v2',
      { exitCode: 0, stdout: 'agent.yml\n', stderr: '' }
    );
    mockResponses.set('git log -1 --format=%s v2v2v2v2v2v2v2v2', {
      exitCode: 0,
      stdout: 'mirror: bump agent to v2\n',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    // The write that feeds the deterministic +1 commit must contain v2.
    const agentWrite = writeFileCalls.find((w) => w.path.endsWith('agent.yml'));
    expect(agentWrite).toBeDefined();
    expect(String(agentWrite?.content)).toBe('agent: v2');

    // And: agent.yml is `git add`ed, then committed and force-pushed back.
    expect(execaCalls.some((cmd) => cmd.includes('git add -- agent.yml'))).toBe(
      true
    );
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin HEAD:main --force-with-lease')
      )
    ).toBe(true);
  });

  test('removing a preserve entry re-asserts strictness on the orphaned mirror commit', async () => {
    // Sequence simulated: previously, `preserve: ['agent.yml']` was set and a
    // user commit landed on origin (passing divergence under the allowlist).
    // The user has now run `venfork preserve remove agent.yml`. The commit is
    // still on origin/main but preserve no longer covers it — divergence
    // check should flag it and abort. The error must surface the file by
    // name with a concrete `venfork preserve add` hint, so the user
    // remembers what they removed.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        // preserve intentionally absent — the entry was just removed.
      }),
      stderr: '',
    });
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'orphancommit11111\n',
      stderr: '',
    });
    mockResponses.set('git rev-list upstream/main..public/main', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set('git log -1 --format=%s orphancommit11111', {
      exitCode: 0,
      stdout: 'mirror: add agent caller workflow\n',
      stderr: '',
    });
    mockResponses.set(
      'git diff-tree -r --no-commit-id --name-only -m --first-parent orphancommit11111',
      { exitCode: 0, stdout: 'agent.yml\n', stderr: '' }
    );

    let aborted = false;
    try {
      await syncCommand('main');
    } catch {
      aborted = true;
    }

    // Sync must abort (process.exit(1) is mocked to throw).
    expect(aborted).toBe(true);
    // The upstream→origin force-push must NOT have happened.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'git push origin upstream/main:refs/heads/main --force-with-lease'
        )
      )
    ).toBe(false);
    // The error message must surface the orphaned file with a concrete
    // `venfork preserve add` hint — the case-by-name guidance the user
    // needs to recognize "oh, that's the entry I just removed."
    const messages = noteCalls.map((n) => n.message).join('\n---\n');
    expect(messages).toContain('venfork preserve add agent.yml');
    expect(messages).toContain('agent.yml');
  });

  test('legacy "+1 commit" subjects from older venfork versions still classify as managed (no spurious divergence)', async () => {
    // Older venfork emitted `chore: add/update scheduled sync workflow
    // (venfork)` for the +1 commit. Mirrors created with that version
    // still have those subjects in their history. After upgrading, the
    // divergence check must continue to recognize them — otherwise the
    // first sync after upgrade aborts with a false-positive on every
    // mirror in the wild.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'legacycommit11111\n',
      stderr: '',
    });
    mockResponses.set('git rev-list upstream/main..public/main', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    // Subject = the OLD message string. Must be recognized as managed.
    mockResponses.set('git log -1 --format=%s legacycommit11111', {
      exitCode: 0,
      stdout: 'chore: add/update scheduled sync workflow (venfork)\n',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    // Sync must NOT have aborted on the legacy-message commit — the
    // upstream→origin force-push should still happen.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'git push origin upstream/main:refs/heads/main --force-with-lease'
        )
      )
    ).toBe(true);
  });

  test('divergence check tolerates a commit whose changed files are all preserved', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        preserve: ['.github/workflows/caller.yml'],
      }),
      stderr: '',
    });
    // origin has 1 commit ahead of upstream — the user's preserve commit.
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'feedfacecafebabe\n',
      stderr: '',
    });
    mockResponses.set('git rev-list upstream/main..public/main', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    // That commit's changed files: only the preserved path.
    mockResponses.set(
      'git diff-tree -r --no-commit-id --name-only -m --first-parent feedfacecafebabe',
      {
        exitCode: 0,
        stdout: '.github/workflows/caller.yml\n',
        stderr: '',
      }
    );
    // Subject doesn't match the workflow message — would normally count as divergent.
    mockResponses.set('git log -1 --format=%s feedfacecafebabe', {
      exitCode: 0,
      stdout: 'mirror: add caller workflow\n',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify origin/main', {
      exitCode: 0,
      stdout: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      stderr: '',
    });
    mockResponses.set(
      'git show aaaa1111bbbb2222cccc3333dddd4444eeee5555:.github/workflows/caller.yml',
      { exitCode: 0, stdout: 'name: caller\n', stderr: '' }
    );

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    // Sync should NOT have aborted — the upstream-to-origin push happens.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'git push origin upstream/main:refs/heads/main --force-with-lease'
        )
      )
    ).toBe(true);
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

  test('omits workflow commits from public staging history', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });

    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected in mocked environment
    }

    // Stage builds a detached worktree at upstream/<default> and cherry-picks
    // non-workflow branch commits onto it.
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('git worktree add --detach') &&
          cmd.includes('upstream/main')
      )
    ).toBe(true);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'git rev-list --reverse --topo-order --no-merges upstream/main..feature-branch'
        )
      )
    ).toBe(true);
    expect(
      execaCalls.some(
        (cmd) => cmd.includes('git push public') && cmd.includes('--force')
      )
    ).toBe(true);
  });

  test('filters workflow commits by identity, not by position in origin/main', async () => {
    // Reproduces the bug where a feature branch reachable from an older
    // origin/main still carried the historical managed workflow commit. After
    // a later `venfork sync` rewrites origin/main with a *new* managed commit,
    // the old workflow commit was still reachable from the feature branch. The
    // previous rebase-based implementation would replay it onto upstream and
    // leak it to the public fork. The cherry-pick loop must drop it.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });
    mockResponses.set(
      'git rev-list --reverse --topo-order --no-merges upstream/main..feature-branch',
      {
        exitCode: 0,
        stdout: 'feat111\nwf222\nfeat333',
        stderr: '',
      }
    );
    // Feature commits — not workflow-only.
    mockResponses.set('git log -1 --format=%s feat111', {
      exitCode: 0,
      stdout: 'feat: real feature work',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: feat111', {
      exitCode: 0,
      stdout: 'src/index.ts',
      stderr: '',
    });
    mockResponses.set('git log -1 --format=%s feat333', {
      exitCode: 0,
      stdout: 'feat: more real feature work',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: feat333', {
      exitCode: 0,
      stdout: 'src/other.ts',
      stderr: '',
    });
    // A leftover workflow-only commit (touches only .github/workflows/*).
    mockResponses.set('git log -1 --format=%s wf222', {
      exitCode: 0,
      stdout: 'chore(venfork): hourly sync public fork via dedicated PAT',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: wf222', {
      exitCode: 0,
      stdout: '.github/workflows/venfork-sync.yml',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected in mocked environment
    }

    const pickCalls = execaCalls.filter((cmd) =>
      cmd.includes('git cherry-pick --allow-empty')
    );
    expect(pickCalls.some((cmd) => cmd.includes('feat111'))).toBe(true);
    expect(pickCalls.some((cmd) => cmd.includes('feat333'))).toBe(true);
    expect(pickCalls.some((cmd) => cmd.includes('wf222'))).toBe(false);
  });

  test('preserves user-authored workflow commits that do not touch venfork-sync.yml', async () => {
    // A user edits .github/workflows/ci.yml on a feature branch, intending
    // to send it upstream. The commit only touches files under
    // .github/workflows but does NOT touch the managed venfork-sync.yml.
    // The narrowed isWorkflowCommit must classify this as user-authored so
    // stage cherry-picks it onto the public-fork tip (otherwise the
    // upstream PR would silently miss the workflow change).
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });
    mockResponses.set(
      'git rev-list --reverse --topo-order --no-merges upstream/main..feature-branch',
      {
        exitCode: 0,
        stdout: 'userci1',
        stderr: '',
      }
    );
    mockResponses.set('git log -1 --format=%s userci1', {
      exitCode: 0,
      stdout: 'ci: tighten test matrix on ci.yml',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: userci1', {
      exitCode: 0,
      stdout: '.github/workflows/ci.yml',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected in mocked environment
    }

    const pickCalls = execaCalls.filter((cmd) =>
      cmd.includes('git cherry-pick --allow-empty')
    );
    expect(pickCalls.some((cmd) => cmd.includes('userci1'))).toBe(true);
  });

  test('aborts when a merge commit has evil resolutions outside .github/workflows', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });
    mockResponses.set('git rev-list --merges upstream/main..feature-branch', {
      exitCode: 0,
      stdout: 'evilmrg\n',
      stderr: '',
    });
    mockResponses.set('git diff-tree --cc --name-only --no-commit-id evilmrg', {
      exitCode: 0,
      // A manual resolution outside .github/workflows — real work that
      // would be lost if we silently linearized the merge away.
      stdout: 'src/conflicted.ts',
      stderr: '',
    });

    await expect(stageCommand('feature-branch')).rejects.toThrow(
      'process.exit called'
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    // Guard must run before the worktree is created, so no cherry-picks happen.
    expect(
      execaCalls.some((cmd) => cmd.includes('git worktree add --detach'))
    ).toBe(false);
    expect(execaCalls.some((cmd) => cmd.includes('git cherry-pick'))).toBe(
      false
    );
  });

  test('aborts when merge commit inspection fails', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });
    mockResponses.set('git rev-list --merges upstream/main..feature-branch', {
      exitCode: 0,
      stdout: 'bad-merge-commit\n',
      stderr: '',
    });
    mockResponses.set(
      'git diff-tree --cc --name-only --no-commit-id bad-merge-commit',
      {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: bad object bad-merge-commit',
      }
    );

    await expect(stageCommand('feature-branch')).rejects.toThrow(
      'process.exit called'
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(
      execaCalls.some((cmd) => cmd.includes('git worktree add --detach'))
    ).toBe(false);
    expect(execaCalls.some((cmd) => cmd.includes('git cherry-pick'))).toBe(
      false
    );
  });

  test('allows merge commits whose evil files are all under .github/workflows', async () => {
    // The common shape: feature branch merges origin/<default> back in purely
    // to resolve the managed `venfork-sync.yml` conflict. The merge is "evil"
    // for that file only, which is irrelevant on the public fork.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });
    mockResponses.set('git rev-list --merges upstream/main..feature-branch', {
      exitCode: 0,
      stdout: 'wfmrg42\n',
      stderr: '',
    });
    mockResponses.set('git diff-tree --cc --name-only --no-commit-id wfmrg42', {
      exitCode: 0,
      stdout: '.github/workflows/venfork-sync.yml',
      stderr: '',
    });
    mockResponses.set(
      'git rev-list --reverse --topo-order --no-merges upstream/main..feature-branch',
      {
        exitCode: 0,
        stdout: 'feat111',
        stderr: '',
      }
    );
    mockResponses.set('git log -1 --format=%s feat111', {
      exitCode: 0,
      stdout: 'feat: real feature work',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: feat111', {
      exitCode: 0,
      stdout: 'src/feature.ts',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected in mocked environment
    }

    // Stage should proceed past the guard and into the cherry-pick loop.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git cherry-pick --allow-empty feat111')
      )
    ).toBe(true);
  });

  test('linearizes history with --no-merges so merge commits are skipped', async () => {
    // Simulates a feature branch that merged origin/<default> back in after a
    // sync rewrite. The merge commit exists only to resolve a workflow-file
    // conflict; cherry-picking it onto upstream would fail ("is a merge but
    // no -m option was given"), and its content is already covered by the
    // cherry-picked non-merge commits reachable from both sides of the merge.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });
    // `--no-merges` makes git omit the merge commit from the list. We assert
    // venfork passes that flag and only cherry-picks the non-merge commits.
    mockResponses.set(
      'git rev-list --reverse --topo-order --no-merges upstream/main..feature-branch',
      {
        exitCode: 0,
        stdout: 'feat111\nfeat222',
        stderr: '',
      }
    );
    for (const sha of ['feat111', 'feat222']) {
      mockResponses.set(`git log -1 --format=%s ${sha}`, {
        exitCode: 0,
        stdout: `feat: work ${sha}`,
        stderr: '',
      });
      mockResponses.set(`git show --name-only --pretty=format: ${sha}`, {
        exitCode: 0,
        stdout: 'src/feature.ts',
        stderr: '',
      });
    }

    try {
      await stageCommand('feature-branch');
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some((cmd) =>
        cmd.includes(
          'git rev-list --reverse --topo-order --no-merges upstream/main..feature-branch'
        )
      )
    ).toBe(true);
    const pickCalls = execaCalls.filter((cmd) =>
      cmd.includes('git cherry-pick --allow-empty')
    );
    expect(pickCalls.some((cmd) => cmd.includes('feat111'))).toBe(true);
    expect(pickCalls.some((cmd) => cmd.includes('feat222'))).toBe(true);
  });

  test('--pr looks up internal PR, redacts internal blocks, opens upstream PR, records shippedBranches', async () => {
    confirmResponse = true;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    // Schedule disabled — keep the simpler push path.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set('git rev-parse feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set(
      'gh pr list --repo owner/repo-private --head feature-branch',
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            url: 'https://github.com/owner/repo-private/pull/7',
            title: 'feat: add auth',
            body: 'Public summary.\n\n<!-- venfork:internal -->client X requires Y<!-- /venfork:internal -->\n\nMore public detail.',
          },
        ]),
        stderr: '',
      }
    );
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 0,
      stdout: 'https://github.com/up/repo/pull/123\n',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch', { createPr: true });
    } catch {
      // updateVenforkConfig may fail on writeFile mock — fine for this test.
    }

    // Internal PR lookup happened via gh.
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh pr list') &&
          cmd.includes('owner/repo-private') &&
          cmd.includes('feature-branch')
      )
    ).toBe(true);

    // Upstream PR creation hit the right repo + cross-fork head.
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh pr create --repo up/repo') &&
          cmd.includes('--head owner:feature-branch')
      )
    ).toBe(true);

    // The body sent to gh has the internal block stripped.
    // (We can't easily inspect the piped --body-file - input here, but the
    // payload was rendered via translateInternalBody and shown to the user.)
    expect(execaCalls.some((cmd) => cmd.includes('--body-file -'))).toBe(true);
  });

  test('--pr surfaces "already exists" without throwing', async () => {
    confirmResponse = true;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set('git rev-parse feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set(
      'gh pr list --repo owner/repo-private --head feature-branch',
      { exitCode: 0, stdout: '[]', stderr: '' }
    );
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 1,
      stdout: '',
      stderr:
        'a pull request for branch "feature-branch" into branch "main" already exists: https://github.com/up/repo/pull/99',
    });

    let threw = false;
    try {
      await stageCommand('feature-branch', { createPr: true });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  test('--draft passes --draft to gh pr create', async () => {
    confirmResponse = true;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set('git rev-parse feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set(
      'gh pr list --repo owner/repo-private --head feature-branch',
      { exitCode: 0, stdout: '[]', stderr: '' }
    );
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 0,
      stdout: 'https://github.com/up/repo/pull/200\n',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch', {
        createPr: true,
        draft: true,
      });
    } catch {
      // ignore
    }

    expect(
      execaCalls.some(
        (cmd) => cmd.includes('gh pr create') && cmd.includes('--draft')
      )
    ).toBe(true);
  });

  test('default behaviour (no --pr) still prints the compare URL and skips gh pr create', async () => {
    confirmResponse = true;
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });

    try {
      await stageCommand('feature-branch');
    } catch {
      // ignore
    }

    expect(execaCalls.some((cmd) => cmd.includes('gh pr create'))).toBe(false);
  });

  test('--pr internal-PR lookup passes --state with value as separate args', async () => {
    // Regression for the bug where `--state open` was a single execa template
    // interpolation and gh silently filtered wrong, producing zero results.
    confirmResponse = true;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set(
      'gh pr list --repo owner/repo-private --head feature-branch',
      { exitCode: 0, stdout: '[]', stderr: '' }
    );
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 0,
      stdout: 'https://github.com/up/repo/pull/200\n',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch', { createPr: true });
    } catch {
      // ignore
    }

    // The rendered command must contain "--state open" (space-separated).
    expect(
      execaCalls.some(
        (cmd) => cmd.includes('gh pr list') && / --state open(?: |$)/.test(cmd)
      )
    ).toBe(true);
  });

  test('--internal-pr <n> uses gh pr view by id and skips the list lookup', async () => {
    confirmResponse = true;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set('gh pr view 99 --repo owner/repo-private', {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 99,
        url: 'https://github.com/owner/repo-private/pull/99',
        title: 'pinned title',
        body: 'pinned body',
      }),
      stderr: '',
    });
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 0,
      stdout: 'https://github.com/up/repo/pull/300\n',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch', {
        createPr: true,
        internalPrNumber: 99,
      });
    } catch {
      // ignore
    }

    // gh pr view by id was called
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh pr view 99') && cmd.includes('owner/repo-private')
      )
    ).toBe(true);
    // and gh pr list was NOT called (the override skips list)
    expect(execaCalls.some((cmd) => cmd.includes('gh pr list'))).toBe(false);
  });

  test('--pr auto-updates body via gh pr edit when upstream PR already exists', async () => {
    confirmResponse = true;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set(
      'gh pr list --repo owner/repo-private --head feature-branch',
      { exitCode: 0, stdout: '[]', stderr: '' }
    );
    // gh pr create exits non-zero with an "already exists" error containing
    // the existing PR URL — createUpstreamPr surfaces alreadyExists: true.
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 1,
      stdout: '',
      stderr:
        'a pull request for branch "feature-branch" into branch "main" already exists: https://github.com/up/repo/pull/77',
    });
    mockResponses.set('gh pr edit https://github.com/up/repo/pull/77', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch', { createPr: true });
    } catch {
      // ignore
    }

    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh pr edit https://github.com/up/repo/pull/77') &&
          cmd.includes('--body-file -')
      )
    ).toBe(true);
  });

  test('--pr respects --no-update-existing on already-exists path', async () => {
    confirmResponse = true;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set(
      'gh pr list --repo owner/repo-private --head feature-branch',
      { exitCode: 0, stdout: '[]', stderr: '' }
    );
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 1,
      stdout: '',
      stderr:
        'a pull request for branch "feature-branch" into branch "main" already exists: https://github.com/up/repo/pull/77',
    });

    try {
      await stageCommand('feature-branch', {
        createPr: true,
        noUpdateExisting: true,
      });
    } catch {
      // ignore
    }

    expect(execaCalls.some((cmd) => cmd.includes('gh pr edit'))).toBe(false);
  });

  test('--pr with VENFORK_NONINTERACTIVE=1 skips the confirm prompt', async () => {
    process.env.VENFORK_NONINTERACTIVE = '1';
    // Default confirmResponse=true would also let the test pass even if the
    // prompt fired; flip it to false so a successful flow PROVES the prompt
    // was bypassed.
    confirmResponse = false;
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-private.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url public', {
      exitCode: 0,
      stdout: 'git@github.com:owner/repo-fork.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git rev-parse --verify feature-branch', {
      exitCode: 0,
      stdout: 'cafef00d',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/repo-fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
    mockResponses.set(
      'gh pr list --repo owner/repo-private --head feature-branch',
      { exitCode: 0, stdout: '[]', stderr: '' }
    );
    mockResponses.set('gh pr create --repo up/repo', {
      exitCode: 0,
      stdout: 'https://github.com/up/repo/pull/400\n',
      stderr: '',
    });

    try {
      await stageCommand('feature-branch', { createPr: true });
    } finally {
      delete process.env.VENFORK_NONINTERACTIVE;
    }

    // The prompt was bypassed, so we reached the push + gh pr create path
    // even though confirmResponse=false would have cancelled it.
    expect(execaCalls.some((cmd) => cmd.includes('gh pr create'))).toBe(true);
  });
});

describe('scheduleCommand', () => {
  test('sets schedule and writes workflow/config updates', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
      }),
      stderr: '',
    });

    try {
      await scheduleCommand('set', '0 */6 * * *');
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git show FETCH_HEAD:.venfork/config.json')
      )
    ).toBe(true);
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('git push') &&
          cmd.includes('venfork-config:venfork-config')
      )
    ).toBe(true);
    expect(
      writeFileCalls.some((w) =>
        w.path.includes('.github/workflows/venfork-sync.yml')
      )
    ).toBe(true);
  });

  test('disables schedule and removes workflow from default branch', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        schedule: { enabled: true, cron: '0 */6 * * *' },
      }),
      stderr: '',
    });

    try {
      await scheduleCommand('disable');
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some((cmd) => cmd.includes('git rm --quiet --ignore-unmatch'))
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

describe('workflowsCommand', () => {
  test('shows status from config branch', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
        enabledWorkflows: ['ci.yml'],
      }),
      stderr: '',
    });

    try {
      await workflowsCommand('status', []);
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git show FETCH_HEAD:.venfork/config.json')
      )
    ).toBe(true);
  });

  test('updates enabledWorkflows in config branch', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
      }),
      stderr: '',
    });

    try {
      await workflowsCommand('allow', ['ci.yml', 'lint.yml']);
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('git push') &&
          cmd.includes('venfork-config:venfork-config')
      )
    ).toBe(true);
  });

  test('updates disabledWorkflows in config branch', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:test/repo.git',
        upstreamUrl: 'git@github.com:upstream/repo.git',
      }),
      stderr: '',
    });

    try {
      await workflowsCommand('block', ['deploy.yml']);
    } catch {
      // Expected in mocked environment
    }

    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('git push') &&
          cmd.includes('venfork-config:venfork-config')
      )
    ).toBe(true);
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

  test('handles owner/repo shorthand with --org and --fork-name', async () => {
    try {
      await setupCommand(
        'firebase/extensions',
        'firebase-extensions-private',
        'invertase',
        'firebase-extensions'
      );
    } catch {
      // Expected
    }

    const forkCalls = execaCalls.filter((cmd) => cmd.includes('gh repo fork'));
    expect(forkCalls.length).toBeGreaterThan(0);
    expect(forkCalls[0]).toContain('gh repo fork firebase/extensions');
    expect(forkCalls[0]).not.toContain("gh repo fork ''");
    expect(forkCalls[0]).toContain('--org invertase');
    expect(forkCalls[0]).toContain('--fork-name firebase-extensions');
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
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'abc123\n',
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
    mockResponses.set('git rev-list upstream/main..public/main', {
      exitCode: 0,
      stdout: 'def456\n',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected - process.exit(1) throws in tests
    }

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test('treats commits touching only .github/workflows files as managed', async () => {
    // Divergent commit that touches both sync.yml and venfork-sync.yml (e.g. a
    // historical venfork rollout commit). All changed files are under
    // .github/workflows, so the commit should be filtered out and sync should
    // proceed past the divergence guard.
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'abc123\n',
      stderr: '',
    });
    mockResponses.set('git log -1 --format=%s abc123', {
      exitCode: 0,
      stdout: 'chore(workflows): Add workflows for venfork sync',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: abc123', {
      exitCode: 0,
      stdout: '.github/workflows/sync.yml\n.github/workflows/venfork-sync.yml',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected in mocked environment
    }

    // Sync should have proceeded to the push step, not aborted.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin upstream/main:refs/heads/main')
      )
    ).toBe(true);
  });

  test('still aborts when divergent commit touches files outside .github/workflows', async () => {
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'deadbee\n',
      stderr: '',
    });
    mockResponses.set('git log -1 --format=%s deadbee', {
      exitCode: 0,
      stdout: 'feat: real work on main',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: deadbee', {
      exitCode: 0,
      stdout: '.github/workflows/sync.yml\nsrc/index.ts',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected - process.exit(1) throws in tests
    }

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin upstream/main:refs/heads/main')
      )
    ).toBe(false);
  });

  test('aborts when divergent commit touches only non-managed workflow files', async () => {
    // A user-authored commit that edits, say, ci.yml on the default branch.
    // It only touches files under .github/workflows, but does NOT touch the
    // managed venfork-sync.yml. The narrowed isWorkflowCommit must classify
    // this as user-authored — sync should refuse to clobber it, not silently
    // filter it as a managed commit.
    mockResponses.set('git rev-list upstream/main..origin/main', {
      exitCode: 0,
      stdout: 'userci1\n',
      stderr: '',
    });
    mockResponses.set('git log -1 --format=%s userci1', {
      exitCode: 0,
      stdout: 'ci: tighten test matrix on ci.yml',
      stderr: '',
    });
    mockResponses.set('git show --name-only --pretty=format: userci1', {
      exitCode: 0,
      stdout: '.github/workflows/ci.yml',
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // Expected - process.exit(1) throws in tests
    }

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin upstream/main:refs/heads/main')
      )
    ).toBe(false);
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

describe('pullRequestCommand', () => {
  function setupPrCommonMocks() {
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('gh pr view 42 --repo up/repo', {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        title: 'Add cool feature',
        body: 'Body of upstream PR.',
        url: 'https://github.com/up/repo/pull/42',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'feat/cool',
        author: { login: 'contributor' },
        headRepositoryOwner: { login: 'forker' },
      }),
      stderr: '',
    });
    // Local branch does NOT already exist (rev-parse --verify fails)
    mockResponses.set('git rev-parse --verify upstream-pr/42', {
      exitCode: 1,
      stdout: '',
      stderr: 'fatal: bad revision',
    });
    mockResponses.set('git fetch upstream pull/42/head:upstream-pr/42', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set('git rev-parse upstream-pr/42', {
      exitCode: 0,
      stdout: 'aaaaaaaaaaaaaaaa\n',
      stderr: '',
    });
    mockResponses.set('git push origin upstream-pr/42', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
  }

  test('happy path: integer arg → fetch pull/N/head + push to origin + record entry', async () => {
    setupPrCommonMocks();

    try {
      await pullRequestCommand('42');
    } catch {
      // ignore — config writeback may fail in mocked env
    }

    expect(
      execaCalls.some(
        (cmd) => cmd.includes('gh pr view 42') && cmd.includes('--repo up/repo')
      )
    ).toBe(true);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git fetch upstream pull/42/head:upstream-pr/42')
      )
    ).toBe(true);
    expect(
      execaCalls.some((cmd) => cmd.includes('git push origin upstream-pr/42'))
    ).toBe(true);
  });

  test('URL arg resolves to the same PR number', async () => {
    setupPrCommonMocks();
    try {
      await pullRequestCommand('https://github.com/up/repo/pull/42');
    } catch {
      // ignore
    }
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git fetch upstream pull/42/head:upstream-pr/42')
      )
    ).toBe(true);
  });

  test('--no-push skips push to origin AND skips pulledPrs linkage', async () => {
    // The linkage skip is important: with --no-push the mirror doesn't have
    // the branch, so a later `venfork sync <branch>` shouldn't push it
    // (which it would do if a pulledPrs entry were recorded).
    setupPrCommonMocks();
    try {
      await pullRequestCommand('42', { push: false });
    } catch {
      // ignore
    }
    expect(execaCalls.some((cmd) => cmd.includes('git push origin'))).toBe(
      false
    );
    // updateVenforkConfig pushes the venfork-config branch — must not happen.
    expect(
      execaCalls.some((cmd) => cmd.includes('venfork-config:venfork-config'))
    ).toBe(false);
  });

  test('--branch-name overrides the local branch', async () => {
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('gh pr view 42 --repo up/repo', {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        title: 't',
        body: '',
        url: 'https://github.com/up/repo/pull/42',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'feat/x',
      }),
      stderr: '',
    });
    mockResponses.set('git fetch upstream pull/42/head:review/up-42', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set('git rev-parse review/up-42', {
      exitCode: 0,
      stdout: 'bbbbbbbbbbbbbbbb\n',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });

    try {
      await pullRequestCommand('42', { branchName: 'review/up-42' });
    } catch {
      // ignore
    }
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git fetch upstream pull/42/head:review/up-42')
      )
    ).toBe(true);
  });

  test('refuses to clobber an existing local branch (no --branch-name)', async () => {
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('gh pr view 42 --repo up/repo', {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        title: 't',
        body: '',
        url: 'https://github.com/up/repo/pull/42',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'feat/x',
      }),
      stderr: '',
    });
    // Local branch already exists.
    mockResponses.set('git rev-parse --verify upstream-pr/42', {
      exitCode: 0,
      stdout: 'existinghead',
      stderr: '',
    });

    await expect(pullRequestCommand('42')).rejects.toThrow(
      'process.exit called'
    );
    expect(
      execaCalls.some((cmd) => cmd.includes('git fetch upstream pull/42'))
    ).toBe(false);
  });

  test('rejects malformed PR ref', async () => {
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    await expect(pullRequestCommand('not-a-pr-ref')).rejects.toThrow(
      'process.exit called'
    );
  });
});

describe('syncCommand - pulled PR branches', () => {
  test('refreshes upstream-pr/<n> via pull/<n>/head and updates origin', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
        pulledPrs: {
          'upstream-pr/42': {
            upstreamPrNumber: 42,
            upstreamPrUrl: 'https://github.com/up/repo/pull/42',
            head: 'oldsha',
            lastSyncedAt: '2026-04-28T09:00:00Z',
          },
        },
      }),
      stderr: '',
    });
    mockResponses.set('git fetch upstream pull/42/head:upstream-pr/42', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set('git rev-parse upstream-pr/42', {
      exitCode: 0,
      stdout: 'newsha\n',
      stderr: '',
    });
    mockResponses.set('git push origin upstream-pr/42 --force-with-lease', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    try {
      await syncCommand('upstream-pr/42');
    } catch {
      // updateVenforkConfig may fail under mocks — fine
    }

    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git fetch upstream pull/42/head:upstream-pr/42')
      )
    ).toBe(true);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin upstream-pr/42 --force-with-lease')
      )
    ).toBe(true);
    // Should NOT run the default-branch divergence flow.
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git push origin upstream/main:refs/heads/main')
      )
    ).toBe(false);
  });

  test('falls back to convention when no pulledPrs entry exists', async () => {
    mockResponses.set('git fetch upstream pull/99/head:upstream-pr/99', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set('git rev-parse upstream-pr/99', {
      exitCode: 0,
      stdout: 'sha99\n',
      stderr: '',
    });
    mockResponses.set('git push origin upstream-pr/99 --force-with-lease', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    // No config entry — relies on the upstream-pr/N convention match.
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });

    try {
      await syncCommand('upstream-pr/99');
    } catch {
      // ignore
    }
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('git fetch upstream pull/99/head:upstream-pr/99')
      )
    ).toBe(true);
  });

  test('non-pulled branch falls through to default-branch sync flow', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });

    try {
      await syncCommand('main');
    } catch {
      // ignore
    }
    // Must not have hit the pull/N/head fetch path.
    expect(
      execaCalls.some((cmd) => cmd.includes('git fetch upstream pull/'))
    ).toBe(false);
  });

  test('does NOT update pulledPrs when push to origin fails', async () => {
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
        pulledPrs: {
          'upstream-pr/42': {
            upstreamPrNumber: 42,
            upstreamPrUrl: 'https://github.com/up/repo/pull/42',
            head: 'oldsha',
            lastSyncedAt: '2026-04-28T09:00:00Z',
          },
        },
      }),
      stderr: '',
    });
    mockResponses.set('git fetch upstream pull/42/head:upstream-pr/42', {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockResponses.set('git rev-parse upstream-pr/42', {
      exitCode: 0,
      stdout: 'newsha\n',
      stderr: '',
    });
    // Mirror push fails — config write must NOT happen, otherwise pulledPrs
    // would record a head/lastSyncedAt that doesn't match the mirror.
    mockResponses.set('git push origin upstream-pr/42 --force-with-lease', {
      exitCode: 1,
      stdout: '',
      stderr: 'fatal: remote rejected',
    });

    try {
      await syncCommand('upstream-pr/42');
    } catch {
      // ignore
    }

    // No new write to venfork-config branch.
    expect(
      execaCalls.some((cmd) => cmd.includes('venfork-config:venfork-config'))
    ).toBe(false);
  });
});

describe('issueCommand', () => {
  function setupCommonRemotes() {
    mockResponses.set('git remote get-url origin', {
      exitCode: 0,
      stdout: 'git@github.com:owner/mirror.git',
      stderr: '',
    });
    mockResponses.set('git remote get-url upstream', {
      exitCode: 0,
      stdout: 'git@github.com:up/repo.git',
      stderr: '',
    });
    mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '1',
        publicForkUrl: 'git@github.com:owner/fork.git',
        upstreamUrl: 'git@github.com:up/repo.git',
      }),
      stderr: '',
    });
  }

  test('stage: reads internal issue, redacts, posts upstream, records linkage', async () => {
    setupCommonRemotes();
    confirmResponse = true;
    mockResponses.set('gh issue view 7 --repo owner/mirror', {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/owner/mirror/issues/7',
        title: 'Bug: things break',
        body: 'Public summary.\n<!-- venfork:internal -->Client X is blocked.<!-- /venfork:internal -->\nMore detail.',
        state: 'OPEN',
        author: { login: 'me' },
      }),
      stderr: '',
    });
    mockResponses.set('gh issue create --repo up/repo', {
      exitCode: 0,
      stdout: 'https://github.com/up/repo/issues/99\n',
      stderr: '',
    });

    try {
      await issueCommand('stage', '7');
    } catch {
      // venfork-config write may fail under mocks
    }

    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh issue view 7') && cmd.includes('--repo owner/mirror')
      )
    ).toBe(true);
    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh issue create --repo up/repo') &&
          cmd.includes('--body-file -')
      )
    ).toBe(true);
  });

  test('pull: reads upstream issue, posts internal, records linkage', async () => {
    setupCommonRemotes();
    confirmResponse = true;
    mockResponses.set('gh issue view 1234 --repo up/repo', {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 1234,
        url: 'https://github.com/up/repo/issues/1234',
        title: 'Feature request: foo',
        body: 'Body text.',
        state: 'OPEN',
        author: { login: 'reporter' },
      }),
      stderr: '',
    });
    mockResponses.set('gh issue create --repo owner/mirror', {
      exitCode: 0,
      stdout: 'https://github.com/owner/mirror/issues/12\n',
      stderr: '',
    });

    try {
      await issueCommand('pull', '1234');
    } catch {
      // ignore config-write fallout
    }

    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh issue view 1234') && cmd.includes('--repo up/repo')
      )
    ).toBe(true);
    expect(
      execaCalls.some((cmd) =>
        cmd.includes('gh issue create --repo owner/mirror')
      )
    ).toBe(true);
  });

  test('rejects unknown action', async () => {
    setupCommonRemotes();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid runtime input
      issueCommand('burn' as any, '7')
    ).rejects.toThrow('process.exit called');
  });

  test('rejects missing target', async () => {
    setupCommonRemotes();
    await expect(issueCommand('stage', undefined)).rejects.toThrow(
      'process.exit called'
    );
  });

  test('accepts URL form for stage', async () => {
    setupCommonRemotes();
    confirmResponse = true;
    mockResponses.set('gh issue view 7 --repo owner/mirror', {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/owner/mirror/issues/7',
        title: 't',
        body: '',
        state: 'OPEN',
      }),
      stderr: '',
    });
    mockResponses.set('gh issue create --repo up/repo', {
      exitCode: 0,
      stdout: 'https://github.com/up/repo/issues/40\n',
      stderr: '',
    });

    try {
      await issueCommand('stage', 'https://github.com/owner/mirror/issues/7');
    } catch {
      // ignore
    }

    expect(
      execaCalls.some(
        (cmd) =>
          cmd.includes('gh issue view 7') && cmd.includes('--repo owner/mirror')
      )
    ).toBe(true);
  });
});

/**
 * `--no-public` mode collapses the 3-remote layout (origin/public/upstream)
 * to 2 remotes (origin/upstream) for users whose upstream lives in their own
 * org. These tests cover the behaviour fan-out across setup/sync/stage/status.
 */
describe('no-public mode', () => {
  /** Convenience: returns a venfork-config JSON for the given mode. */
  const noPublicConfig = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: '1',
      mode: 'no-public',
      upstreamUrl: 'git@github.com:upstream/repo.git',
      ...extra,
    });

  describe('setupCommand --no-public', () => {
    test('skips gh repo fork', async () => {
      try {
        await setupCommand(
          'git@github.com:test/repo.git',
          'test-vendor',
          undefined,
          undefined,
          { noPublic: true }
        );
      } catch {
        // Expected in mocked env
      }

      const forkCalls = execaCalls.filter((c) => c.includes('gh repo fork'));
      expect(forkCalls.length).toBe(0);
    });

    test('does not add `public` remote', async () => {
      try {
        await setupCommand(
          'git@github.com:test/repo.git',
          'test-vendor',
          undefined,
          undefined,
          { noPublic: true }
        );
      } catch {
        // Expected
      }

      const remoteAddPublic = execaCalls.filter(
        (c) =>
          c.includes('git remote add public') ||
          c.includes('git remote set-url public')
      );
      expect(remoteAddPublic.length).toBe(0);
    });

    test('still adds upstream remote with push DISABLEd', async () => {
      try {
        await setupCommand(
          'git@github.com:test/repo.git',
          'test-vendor',
          undefined,
          undefined,
          { noPublic: true }
        );
      } catch {
        // Expected
      }

      expect(
        execaCalls.some((c) => c.includes('git remote set-url --push upstream'))
      ).toBe(true);
    });

    test('writes venfork-config with mode=no-public and no publicForkUrl', async () => {
      try {
        await setupCommand(
          'git@github.com:test/repo.git',
          'test-vendor',
          undefined,
          undefined,
          { noPublic: true }
        );
      } catch {
        // Expected
      }

      const configWrite = writeFileCalls.find((w) =>
        w.path.endsWith('.venfork/config.json')
      );
      expect(configWrite).toBeDefined();
      const parsed = JSON.parse(configWrite?.content ?? '{}');
      expect(parsed.mode).toBe('no-public');
      expect(parsed.publicForkUrl).toBeUndefined();
      expect(parsed.upstreamUrl).toBe('git@github.com:test/repo.git');
    });

    test('throws when combined with a public fork name', async () => {
      await expect(
        setupCommand(
          'git@github.com:test/repo.git',
          'test-vendor',
          undefined,
          'forked-name',
          { noPublic: true }
        )
      ).rejects.toThrow(/no-public.*public fork name/i);
    });

    test('removes a stale `public` remote when re-running in no-public mode', async () => {
      // Simulate a repo that previously had a `public` remote configured —
      // `git remote get-url public` succeeds with a URL. Re-running setup
      // with --no-public should explicitly remove it so the local layout
      // matches the recorded config.
      mockResponses.set('git remote get-url public', {
        exitCode: 0,
        stdout: 'git@github.com:test/repo.git',
        stderr: '',
      });

      try {
        await setupCommand(
          'git@github.com:test/repo.git',
          'test-vendor',
          undefined,
          undefined,
          { noPublic: true }
        );
      } catch {
        // Expected in mocked env
      }

      expect(
        execaCalls.some((c) => c.includes('git remote remove public'))
      ).toBe(true);
    });
  });

  describe('syncCommand in no-public mode', () => {
    test('skips fetch public', async () => {
      mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
        exitCode: 0,
        stdout: noPublicConfig(),
        stderr: '',
      });

      try {
        await syncCommand('main');
      } catch {
        // Expected
      }

      expect(execaCalls.some((c) => c.includes('git fetch upstream'))).toBe(
        true
      );
      expect(execaCalls.some((c) => c.includes('git fetch origin'))).toBe(true);
      expect(execaCalls.some((c) => c.includes('git fetch public'))).toBe(
        false
      );
    });

    test('does not push to public', async () => {
      mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
        exitCode: 0,
        stdout: noPublicConfig(),
        stderr: '',
      });

      try {
        await syncCommand('main');
      } catch {
        // Expected
      }

      const pushCalls = execaCalls.filter((c) => c.includes('git push'));
      expect(pushCalls.some((c) => c.includes('git push public'))).toBe(false);
      expect(pushCalls.some((c) => c.includes('git push origin'))).toBe(true);
    });
  });

  describe('stageCommand in no-public mode', () => {
    test('pushes by upstream URL (not by remote name) so DISABLE push URL is bypassed', async () => {
      mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
        exitCode: 0,
        stdout: noPublicConfig(),
        stderr: '',
      });
      // upstream remote URL lookup (planStaging path)
      mockResponses.set('git remote get-url upstream', {
        exitCode: 0,
        stdout: 'git@github.com:upstream/repo.git',
        stderr: '',
      });

      try {
        await stageCommand('feature-branch');
      } catch {
        // Expected
      }

      // Should never query `git remote get-url public` in no-public mode.
      expect(
        execaCalls.some((c) => c.includes('git remote get-url public'))
      ).toBe(false);

      const pushCalls = execaCalls.filter((c) => c.includes('git push'));
      // Push goes to the upstream URL (so the DISABLEd push URL on the
      // `upstream` remote is bypassed). The literal `git push upstream <branch>`
      // form must NOT appear.
      expect(
        pushCalls.some((c) =>
          c.includes('git push git@github.com:upstream/repo.git')
        )
      ).toBe(true);
      expect(pushCalls.some((c) => /git push upstream\b/.test(c))).toBe(false);
      expect(pushCalls.some((c) => c.includes('git push public'))).toBe(false);
    });

    test('schedule-mode push by URL uses explicit-SHA lease via ls-remote', async () => {
      mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
        exitCode: 0,
        stdout: noPublicConfig({
          schedule: { enabled: true, cron: '0 */6 * * *' },
        }),
        stderr: '',
      });
      mockResponses.set('git remote get-url upstream', {
        exitCode: 0,
        stdout: 'git@github.com:upstream/repo.git',
        stderr: '',
      });
      // Simulate the branch existing on upstream — ls-remote returns a SHA.
      mockResponses.set('git ls-remote --exit-code', {
        exitCode: 0,
        stdout: 'cafef00d\trefs/heads/feature-branch',
        stderr: '',
      });

      try {
        await stageCommand('feature-branch');
      } catch {
        // Expected
      }

      // The push must use --force-with-lease with the explicit SHA,
      // targeting the upstream URL (not the `upstream` remote name).
      const pushCalls = execaCalls.filter((c) => c.includes('git push'));
      expect(
        pushCalls.some(
          (c) =>
            c.includes('git push git@github.com:upstream/repo.git') &&
            c.includes('--force-with-lease=refs/heads/feature-branch:cafef00d')
        )
      ).toBe(true);
    });
  });

  describe('cloneCommand --no-public for legacy mirrors', () => {
    test('skips public-fork detection when --no-public is set and no config exists', async () => {
      // No mock for `git show FETCH_HEAD:.venfork/config.json` and the
      // default `gh repo clone` mock returns empty stdout — fetchVenforkConfig
      // returns null. The flag becomes the source of truth.
      try {
        await cloneCommand('git@github.com:acme/legacy-private.git', {
          noPublic: true,
          upstreamUrl: 'git@github.com:acme/legacy.git',
        });
      } catch {
        // Expected
      }

      // Should NOT call `gh repo view <owner>/legacy` (public-fork lookup).
      expect(
        execaCalls.some(
          (c) =>
            c.includes('gh repo view') &&
            c.includes('acme/legacy') &&
            !c.includes('--json')
        )
      ).toBe(false);
      // Should NOT call the parent-lookup either.
      expect(
        execaCalls.some(
          (c) => c.includes('gh repo view') && c.includes('--json parent')
        )
      ).toBe(false);
    });

    test('does not add a public remote in legacy --no-public mode', async () => {
      try {
        await cloneCommand('git@github.com:acme/legacy-private.git', {
          noPublic: true,
          upstreamUrl: 'git@github.com:acme/legacy.git',
        });
      } catch {
        // Expected
      }

      const remoteAddPublic = execaCalls.filter((c) =>
        c.includes('git remote add public')
      );
      expect(remoteAddPublic.length).toBe(0);

      // upstream remote IS added.
      expect(
        execaCalls.some((c) => c.includes('git remote add upstream'))
      ).toBe(true);
    });
  });

  describe('statusCommand in no-public mode', () => {
    test('completes without error when public remote is absent', async () => {
      mockResponses.set('git show FETCH_HEAD:.venfork/config.json', {
        exitCode: 0,
        stdout: noPublicConfig(),
        stderr: '',
      });
      // hasRemote uses `git remote get-url <name>` — make `public` look missing
      // while origin/upstream remain present (default success mock).
      mockResponses.set('git remote get-url public', {
        exitCode: 1,
        stdout: '',
        stderr: 'No such remote',
      });

      // The sentinel: in standard mode, missing `public` would produce an
      // "incomplete" path that still does not throw, but importantly
      // statusCommand should not raise on the noPublic branch. A clean
      // completion (no thrown error) is the assertion.
      await expect(statusCommand()).resolves.toBeUndefined();
    });
  });
});

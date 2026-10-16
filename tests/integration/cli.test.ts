import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import {
  createMirrorFixture,
  type MirrorFixture,
} from '../harness/mirror-fixture.js';
import { seedPreserve } from '../harness/preserve.js';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
let tmp: string;
let entry: string;
let stubPath: string;
/** PATH whose gh passes `gh auth status` and fails everything else. */
let authedPath: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'venfork-cli-'));
  const outdir = path.join(tmp, 'dist');
  await $({
    cwd: repoRoot,
  })`bun build ./src/index.ts --outdir ${outdir} --target node`;
  entry = path.join(outdir, 'index.js');
  const bin = path.join(tmp, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(bin, 'gh'), 0o755);
  stubPath = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  const authedBin = path.join(tmp, 'authed-bin');
  await mkdir(authedBin);
  await writeFile(
    path.join(authedBin, 'gh'),
    '#!/bin/sh\n[ "$1 $2" = "auth status" ] && exit 0\nexit 1\n'
  );
  await chmod(path.join(authedBin, 'gh'), 0o755);
  authedPath = `${authedBin}${path.delimiter}${process.env.PATH ?? ''}`;
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runCli(...args: string[]) {
  return runCliIn(tmp, ...args);
}

function runCliIn(cwd: string, ...args: string[]) {
  return $({
    cwd,
    reject: false,
    all: true,
    env: { PATH: stubPath },
  })`node ${entry} ${args}`;
}

/**
 * Runs argv on a pty, waits for $MARKER in its output, then closes the pty
 * so the child's stdin ends at a TTY. Prints the output and `EXIT=<code>`.
 */
const PTY_EOF_SCRIPT = `
import fcntl, os, select, struct, subprocess, sys, termios, time
marker = os.environ['MARKER'].encode()
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
proc = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
buf = b''
deadline = time.time() + 20
while marker not in buf and time.time() < deadline:
    if select.select([master], [], [], 0.2)[0]:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
time.sleep(0.3)
while select.select([master], [], [], 0)[0]:
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
os.close(master)
try:
    code = proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
    code = 'HUNG'
sys.stdout.write(buf.decode(errors='replace'))
print('\\nEXIT=%s' % code)
`;

/**
 * Runs argv with stdin and stdout on a pty and stderr in $ERRFILE, and
 * waits up to 15 s for it to exit. Prints `EXIT=<code>` or `EXIT=HUNG`.
 */
const PTY_STDERR_FILE_SCRIPT = `
import fcntl, os, struct, subprocess, sys, termios
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
with open(os.environ['ERRFILE'], 'wb') as err:
    proc = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=err, close_fds=True)
    os.close(slave)
    try:
        code = proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        code = 'HUNG'
os.close(master)
print('EXIT=%s' % code)
`;

describe('built CLI entry point', () => {
  test('--version prints the package version', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8')
    ) as { version: string };

    const result = await runCli('--version');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test('a command that finishes is not reported as an abandoned prompt', async () => {
    const result = await $({
      cwd: tmp,
      reject: false,
      stdin: { file: '/dev/null' },
      env: { PATH: authedPath },
    })`node ${entry} --version`;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  test.skipIf(Bun.which('python3') === null)(
    'EOF at a TTY confirm exits 130',
    async () => {
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        PATH: authedPath,
        MARKER: 'Continue with personal account?',
      };
      delete childEnv.CI;
      delete childEnv.VENFORK_NONINTERACTIVE;
      delete childEnv.VENFORK_ORG;
      const result = await $({
        cwd: tmp,
        reject: false,
        timeout: 30000,
        env: childEnv,
        extendEnv: false,
      })`python3 -c ${PTY_EOF_SCRIPT} node ${entry} setup a/b b-private`;

      expect(result.stdout).toContain('Continue with personal account?');
      expect(result.stdout.trim().split('\n').at(-1)).toBe('EXIT=130');
    }
  );

  test('setup without gh auth exits 1 with the AuthenticationError message', async () => {
    const result = await runCli('setup');

    expect(result.exitCode).toBe(1);
    expect(result.all).toContain(
      'GitHub CLI is not authenticated. Please run: gh auth login'
    );
  });
});

/**
 * Runs the CLI the way a script or agent does: stdin is an open pipe that
 * never sends input, and CI and VENFORK_NONINTERACTIVE are unset unless
 * `env` sets them, so only the missing TTY stops the prompt.
 */
function runCliWithoutTty(
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: authedPath,
    ...env,
  };
  if (!('CI' in env)) delete childEnv.CI;
  if (!('VENFORK_NONINTERACTIVE' in env)) {
    delete childEnv.VENFORK_NONINTERACTIVE;
  }
  delete childEnv.VENFORK_ORG;
  return $({
    cwd,
    reject: false,
    stdin: 'pipe',
    timeout: 5000,
    env: childEnv,
    extendEnv: false,
  })`node ${entry} ${args}`;
}

async function cutFeatureBranch(fx: MirrorFixture): Promise<void> {
  await fx.git(fx.work, 'checkout', '--quiet', '-b', 'feature');
  await writeFile(path.join(fx.work, 'src-feature.txt'), 'feature\n');
  await fx.git(fx.work, 'add', 'src-feature.txt');
  await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: feature work');
}

async function hasBranch(repo: string, branch: string): Promise<boolean> {
  const result = await $({
    cwd: repo,
    reject: false,
  })`git rev-parse --verify --quiet refs/heads/${branch}`;
  return result.exitCode === 0;
}

async function pathExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false
  );
}

describe('no TTY: fail fast instead of prompting', () => {
  test('setup without an upstream exits 2 naming the <upstream> argument', async () => {
    const result = await runCliWithoutTty(tmp, ['setup', '--org', 'acme']);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Pass the <upstream> argument.');
  });

  test('setup without a mirror name uses <repo>-private and says so', async () => {
    const result = await runCliWithoutTty(tmp, ['setup', 'a/b', '--org', 'c']);

    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Private mirror repo name? b-private');
    expect(result.stderr).not.toContain('Cancelled: input ended at a prompt');
  });

  test('setup on a personal account exits 2 naming --yes', async () => {
    const result = await runCliWithoutTty(tmp, ['setup', 'a/b', 'b-private']);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Continue with personal account?');
    expect(result.stderr).toContain('Pass --yes.');
  });

  test('stage without --yes exits 2 naming --yes and pushes nothing; with --yes it pushes', async () => {
    const fx = await createMirrorFixture();
    try {
      await cutFeatureBranch(fx);
      const publicFork = fx.publicFork ?? '';

      const refused = await runCliWithoutTty(fx.work, ['stage', 'feature']);
      expect(refused.timedOut).toBe(false);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('Push to public fork?');
      expect(refused.stderr).toContain('Pass --yes.');
      expect(await hasBranch(publicFork, 'feature')).toBe(false);

      const staged = await runCliWithoutTty(fx.work, [
        'stage',
        'feature',
        '--yes',
      ]);
      expect(staged.exitCode).toBe(0);
      expect(staged.stdout).toBe('');
      expect(await fx.fileAt(publicFork, 'feature', 'src-feature.txt')).toBe(
        'feature\n'
      );
    } finally {
      await fx.cleanup();
    }
  });

  test('stage without --yes and no TTY exits 2 before fetching', async () => {
    const fx = await createMirrorFixture();
    try {
      await cutFeatureBranch(fx);
      await fx.git(
        fx.work,
        'remote',
        'set-url',
        'upstream',
        path.join(tmp, 'no-such-upstream.git')
      );

      const result = await runCliWithoutTty(fx.work, ['stage', 'feature']);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Push to public fork?');
      expect(result.stderr).toContain('Pass --yes.');
      expect(result.stderr).not.toContain('git fetch upstream failed');
      expect(result.stderr).toContain(
        'cancelled: Not staged: the push confirm needs --yes'
      );
    } finally {
      await fx.cleanup();
    }
  });

  test('stage issue without --yes and no TTY exits 2 naming --yes before reading the issue', async () => {
    const fx = await createMirrorFixture();
    const logDir = await mkdtemp(path.join(tmp, 'gh-log-'));
    const ghLog = path.join(logDir, 'gh.log');
    const bin = path.join(logDir, 'bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'gh'),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(ghLog)}\n[ "$1 $2" = "auth status" ] && exit 0\nexit 1\n`
    );
    await chmod(path.join(bin, 'gh'), 0o755);
    try {
      await fx.git(
        fx.work,
        'remote',
        'set-url',
        'origin',
        'git@github.com:acme/project-private.git'
      );
      await fx.git(
        fx.work,
        'remote',
        'set-url',
        'upstream',
        'git@github.com:client/project.git'
      );

      const result = await runCliWithoutTty(fx.work, ['stage', 'issue', '7'], {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Open the issue on client/project?');
      expect(result.stderr).toContain('Pass --yes.');
      const calls = await readFile(ghLog, 'utf8').catch(() => '');
      expect(calls).not.toContain('issue view');
      expect(calls).not.toContain('issue create');
    } finally {
      await fx.cleanup();
    }
  });

  test('clone exit 2 on a legacy mirror leaves no directory, and the rerun with the named flag succeeds', async () => {
    const fx = await createMirrorFixture();
    const root = await mkdtemp(path.join(tmp, 'legacy-clone-'));
    try {
      const repos = path.join(root, 'repos');
      await $`git clone --quiet --bare ${fx.upstream} ${path.join(repos, 'acme', 'proj-private.git')}`;
      const bin = path.join(root, 'bin');
      await mkdir(bin);
      await writeFile(
        path.join(bin, 'gh'),
        [
          '#!/bin/sh',
          'case "$1 $2" in',
          '  "auth status") exit 0;;',
          '  "config get") echo ssh; exit 0;;',
          '  "repo set-default") exit 0;;',
          '  "repo clone")',
          '    src="$3"; dst="$4"; shift 4; [ "$1" = "--" ] && shift',
          '    exec git clone -q "$@" "$GHSTUB_REPOS/$src.git" "$dst";;',
          'esac',
          'exit 1',
          '',
        ].join('\n')
      );
      await chmod(path.join(bin, 'gh'), 0o755);
      const work = path.join(root, 'work');
      await mkdir(work);
      const env = {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        GHSTUB_REPOS: repos,
      };

      const refused = await runCliWithoutTty(
        work,
        ['clone', 'acme/proj-private'],
        env
      );
      expect(refused.timedOut).toBe(false);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain('Pass --public-fork <url>.');
      expect(await pathExists(path.join(work, 'proj-private'))).toBe(false);

      const cloned = await runCliWithoutTty(
        work,
        [
          'clone',
          'acme/proj-private',
          '--public-fork',
          'acme/proj',
          '--upstream',
          'git@github.com:client/proj.git',
        ],
        env
      );
      expect(cloned.stderr).not.toContain('already exists');
      expect(cloned.exitCode).toBe(0);
      const remote = await $({
        cwd: path.join(work, 'proj-private'),
      })`git remote get-url upstream`;
      expect(remote.stdout.trim()).toBe('git@github.com:client/proj.git');
    } finally {
      await fx.cleanup();
    }
  });

  test.skipIf(Bun.which('python3') === null)(
    'stage with stderr redirected at a TTY exits 2 instead of a hidden prompt',
    async () => {
      const fx = await createMirrorFixture();
      try {
        await cutFeatureBranch(fx);
        const errFile = path.join(fx.root, 'stage-stderr.txt');
        const childEnv: Record<string, string | undefined> = {
          ...process.env,
          PATH: authedPath,
          ERRFILE: errFile,
        };
        delete childEnv.CI;
        delete childEnv.VENFORK_NONINTERACTIVE;
        const result = await $({
          cwd: fx.work,
          reject: false,
          timeout: 30000,
          env: childEnv,
          extendEnv: false,
        })`python3 -c ${PTY_STDERR_FILE_SCRIPT} node ${entry} stage feature`;

        expect(result.stdout.trim().split('\n').at(-1)).toBe('EXIT=2');
        expect(await readFile(errFile, 'utf8')).toContain('Pass --yes.');
        expect(await hasBranch(fx.publicFork ?? '', 'feature')).toBe(false);
      } finally {
        await fx.cleanup();
      }
    }
  );

  test('VENFORK_NONINTERACTIVE=1 no longer confirms: stage exits 2 naming --yes', async () => {
    const fx = await createMirrorFixture();
    try {
      await cutFeatureBranch(fx);

      const result = await runCliWithoutTty(fx.work, ['stage', 'feature'], {
        VENFORK_NONINTERACTIVE: '1',
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Pass --yes.');
      expect(await hasBranch(fx.publicFork ?? '', 'feature')).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('clone on a legacy mirror without venfork-config', () => {
  /**
   * Strips the fixture's config branch and returns a PATH whose gh clones
   * the fixture origin, reports the fixture upstream as every fork's parent
   * and finds no other repository. Each gh call is appended to `ghLog`.
   */
  async function legacyMirror(
    fx: MirrorFixture
  ): Promise<{ path: string; ghLog: string }> {
    await fx.git(fx.origin, 'branch', '-D', 'venfork-config');
    const bin = path.join(fx.root, 'gh-bin');
    const ghLog = path.join(fx.root, 'gh.log');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${ghLog}'`,
        'case "$1 $2" in',
        '  "auth status"|"repo set-default") exit 0 ;;',
        '  "config get") echo ssh; exit 0 ;;',
        '  "repo clone")',
        '    dir="$4"; shift 4; [ "$1" = "--" ] && shift',
        `    exec git clone --quiet "$@" '${fx.origin}' "$dir" ;;`,
        '  "repo view")',
        `    case "$*" in *"--json parent"*) echo '${fx.upstream}'; exit 0 ;; esac ;;`,
        'esac',
        'exit 1',
        '',
      ].join('\n')
    );
    await chmod(path.join(bin, 'gh'), 0o755);
    return { path: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, ghLog };
  }

  test('--public-fork wires public and upstream from that fork, with no prompt', async () => {
    const fx = await createMirrorFixture();
    try {
      const { path: ghPath, ghLog } = await legacyMirror(fx);

      const result = await runCliWithoutTty(
        fx.root,
        ['clone', 'acme/legacy-private', '--public-fork', 'other-org/legacy'],
        { PATH: ghPath }
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      const clone = path.join(fx.root, 'legacy-private');
      expect(await fx.git(clone, 'remote', 'get-url', 'public')).toBe(
        'git@github.com:other-org/legacy.git'
      );
      expect(await fx.git(clone, 'remote', 'get-url', 'upstream')).toBe(
        fx.upstream
      );
      expect(
        await fx.git(clone, 'remote', 'get-url', '--push', 'upstream')
      ).toBe('DISABLE');
      const calls = (await readFile(ghLog, 'utf8')).trim().split('\n');
      expect(calls.filter((c) => c.startsWith('repo view'))).toEqual([
        'repo view other-org/legacy --json parent --jq .parent.url',
      ]);
    } finally {
      await fx.cleanup();
    }
  });

  test('--json reports the checkout and its remotes on stdout', async () => {
    const fx = await createMirrorFixture();
    try {
      const { path: ghPath } = await legacyMirror(fx);

      const result = await runCliWithoutTty(
        fx.root,
        [
          'clone',
          'acme/legacy-private',
          '--public-fork',
          'other-org/legacy',
          '--json',
        ],
        { PATH: ghPath }
      );

      expect(result.exitCode).toBe(0);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        result: {
          mode: 'standard',
          directory: path.join(await realpath(fx.root), 'legacy-private'),
          remotes: {
            origin: fx.origin,
            public: 'git@github.com:other-org/legacy.git',
            upstream: fx.upstream,
          },
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('--json without --public-fork is a missing-input envelope, exit 2', async () => {
    const fx = await createMirrorFixture();
    try {
      const { path: ghPath } = await legacyMirror(fx);

      const result = await runCliWithoutTty(
        fx.root,
        ['clone', 'acme/legacy-private', '--json'],
        { PATH: ghPath }
      );

      expect(result.exitCode).toBe(2);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'missing-input',
          message: expect.stringContaining(
            'Please provide the public fork URL:'
          ),
          flag: '--public-fork <url>',
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('without --public-fork, an undetected fork exits 2 naming --public-fork <url>', async () => {
    const fx = await createMirrorFixture();
    try {
      const { path: ghPath } = await legacyMirror(fx);

      const result = await runCliWithoutTty(
        fx.root,
        ['clone', 'acme/legacy-private'],
        { PATH: ghPath }
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Please provide the public fork URL:');
      expect(result.stderr).toContain('Pass --public-fork <url>.');
      expect(await pathExists(path.join(fx.root, 'legacy-private'))).toBe(
        false
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describe('per-command help', () => {
  for (const [command, usage] of [
    ['sync', 'venfork sync [branch] [--report-issues]'],
    ['doctor', 'venfork doctor [--json]'],
    ['stage', 'venfork stage <branch>'],
  ]) {
    for (const flag of ['-h', '--help']) {
      test(`${command} ${flag} prints its usage and exits 0`, async () => {
        const result = await runCli(command, flag);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(usage);
        expect(result.stdout).not.toContain('venfork setup <upstream>');
        expect(result.stderr).toBe('');
      });
    }
  }

  for (const [args, usage] of [
    [['help', 'doctor'], 'venfork doctor [--json]'],
    [['--help', 'sync'], 'venfork sync [branch] [--report-issues]'],
    [['-h', 'stage'], 'venfork stage <branch>'],
    [['help', 'pull', 'pr'], 'venfork pull pr <pr-number-or-url>'],
  ] as const) {
    test(`${args.join(' ')} prints only that command's help`, async () => {
      const result = await runCli(...args);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(usage);
      expect(result.stdout).not.toContain('venfork setup <upstream>');
    });
  }

  test('venfork help and --help still print the full help', async () => {
    for (const args of [['help'], ['--help'], ['-h']]) {
      const result = await runCli(...args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('venfork setup <upstream>');
      expect(result.stdout).toContain('venfork doctor [--json]');
    }
  });

  test('errors go to stderr, not stdout', async () => {
    const result = await runCli('sync', '--bogus');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown option '--bogus'");
    expect(result.stdout).not.toContain('--bogus');
  });

  test('an unknown command is reported on stderr', async () => {
    const result = await runCli('frobnicate');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown command: frobnicate');
  });

  for (const [args, hints] of [
    [
      ['pull-request', '1'],
      ['`venfork pull-request` is now `venfork pull pr <number-or-url>`'],
    ],
    [
      ['issue', 'pull', '1'],
      [
        'venfork pull issue <number-or-url>',
        'venfork stage issue <number-or-url>',
      ],
    ],
    [
      ['issue', 'stage', '1'],
      [
        'venfork pull issue <number-or-url>',
        'venfork stage issue <number-or-url>',
      ],
    ],
    [['status'], ['`venfork status` is now `venfork doctor`']],
  ] as const) {
    test(`renamed command ${args.join(' ')} names its replacement on stderr`, async () => {
      const result = await runCli(...args);

      expect(result.exitCode).toBe(2);
      for (const hint of hints) expect(result.stderr).toContain(hint);
      expect(result.stderr).not.toContain('Unknown command');
      expect(result.stdout).toBe('');
    });
  }

  for (const [args, usage] of [
    [['pull', 'pr', '--help'], 'venfork pull pr <pr-number-or-url>'],
    [['pull', 'issue', '--help'], 'venfork pull issue <number-or-url>'],
    [['stage', 'issue', '--help'], 'venfork stage issue <number-or-url>'],
    [['pull', '--help'], 'venfork pull issue <number-or-url>'],
  ] as const) {
    test(`${args.join(' ')} prints its usage and exits 0`, async () => {
      const result = await runCli(...args);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(usage);
      expect(result.stdout).not.toContain('venfork setup <upstream>');
      expect(result.stderr).toBe('');
    });
  }

  test('bare `stage issue` without a ref points at `stage branch issue`', async () => {
    const result = await runCli('stage', 'issue');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('venfork stage branch issue');
  });
});

describe('usage errors', () => {
  for (const [args, usage] of [
    [['stage'], 'venfork stage <branch>'],
    [['pull', 'pr'], 'venfork pull pr <pr-number-or-url>'],
    [['pull', 'issue'], 'venfork pull issue <number-or-url>'],
    [['pull'], 'venfork pull <pr|issue> <number-or-url>'],
    [
      ['schedule', 'frobnicate'],
      'venfork schedule <status|set <cron> [--app|--token]|disable>',
    ],
    [
      ['schedule', 'set'],
      'venfork schedule <status|set <cron> [--app|--token]|disable>',
    ],
  ] as const) {
    test(`${args.join(' ')} reports usage on stderr only`, async () => {
      const result = await runCli(...args);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(usage);
    });
  }
});

describe('usage errors exit 2 with the error on stderr', () => {
  for (const [args, message] of [
    [['frobnicate'], 'Unknown command: frobnicate'],
    [['setup', 'a/b', '--bogus'], "Unknown option '--bogus'"],
    [['setup', 'a/b', 'c', 'd'], "Unexpected argument 'd'"],
    [['setup', 'a/b', '--org'], '--org requires a value'],
    [['setup', 'a/b', '--no-public', '--fork-name', 'x'], 'cannot be combined'],
    [['setup', 'not a repo'], 'Invalid upstream repository'],
    [['setup', 'a/b', '--fork-name', 'bad name'], 'Invalid --fork-name'],
    [['clone'], 'Missing vendor repository'],
    [['clone', 'not a repo'], 'Invalid vendor repository'],
    [
      ['clone', 'a/b-private', '--no-public', '--public-fork', 'a/b'],
      '--public-fork cannot be combined with --no-public',
    ],
    [['clone', 'a/b-private', '--public-fork', 'x y'], 'Invalid --public-fork'],
    [['sync', 'a', 'b'], 'Usage: venfork sync'],
    [['schedule', 'set', 'not a cron'], "Invalid cron expression 'not a cron'"],
    [['schedule', 'status', '--app'], "--app applies only to 'schedule set'"],
    [['stage', 'feat', '--internal-pr', 'x'], '--internal-pr requires'],
    [['stage', 'issue', 'abc'], 'Could not parse issue reference: abc'],
    [['stage', 'issue', '1', '--pr'], '--pr only applies to stage branch'],
    [['pull', 'nope'], 'Unknown pull target: nope'],
    [['pull', 'pr', 'abc'], 'Could not parse PR reference: abc'],
    [['pull', 'issue', '1', '--no-push'], "Unknown option '--no-push'"],
    [['doctor', '--bogus'], "Unknown option '--bogus'"],
    [['workflows', 'nope'], 'Usage: venfork workflows'],
    [['workflows', 'allow'], 'Usage: venfork workflows allow'],
    [['preserve', 'nope'], 'Usage: venfork preserve'],
    [['preserve', 'add'], 'Usage: venfork preserve add'],
    [['preserve', 'add', '../escape'], "Invalid preserve path '../escape'"],
  ] as const) {
    test(`venfork ${args.join(' ')}`, async () => {
      const result = await runCliIn(tmp, ...args);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(message);
    });
  }

  test('a usage error is reported before gh auth is checked', async () => {
    const result = await runCli('clone', 'a/b-private', '--bogus');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown option '--bogus'");
    expect(result.stderr).not.toContain('not authenticated');
  });

  test('bare venfork prints usage on stderr and exits 2', async () => {
    const result = await runCli();

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('venfork setup <upstream>');
  });

  test('a runtime failure still exits 1', async () => {
    const result = await runCli('sync');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });
});

/** Parses stdout that must be exactly one line holding one JSON envelope. */
function parseEnvelope(stdout: string): Record<string, unknown> {
  expect(stdout.split('\n')).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function doctorResult(stdout: string): {
  checks: Array<{ id: string; ok: unknown }>;
  healthy?: unknown;
} {
  const envelope = parseEnvelope(stdout);
  expect(envelope).toMatchObject({ schemaVersion: 1, ok: true });
  return envelope.result as {
    checks: Array<{ id: string; ok: unknown }>;
    healthy?: unknown;
  };
}

describe('doctor --json output', () => {
  test('stays pure JSON in every state, including an invalid cron', async () => {
    const fx = await createMirrorFixture();
    try {
      const outputs: string[] = [];
      outputs.push((await runCliIn(fx.root, 'doctor', '--json')).stdout);
      outputs.push((await runCliIn(fx.work, 'doctor', '--json')).stdout);

      await rename(fx.upstream, `${fx.upstream}.gone`);
      try {
        outputs.push((await runCliIn(fx.work, 'doctor', '--json')).stdout);
      } finally {
        await rename(`${fx.upstream}.gone`, fx.upstream);
      }

      const raw = await fx.readRawConfig();
      await fx.writeRawConfig(
        JSON.stringify({ ...raw, schedule: { enabled: true, cron: '@hourly' } })
      );
      const invalidCron = await runCliIn(fx.work, 'doctor', '--json');
      outputs.push(invalidCron.stdout);
      expect(invalidCron.exitCode).toBe(1);

      for (const stdout of outputs) {
        const { checks } = doctorResult(stdout);
        expect(checks[0].id).toBe('repo');
        expect(checks).toHaveLength(10);
      }
      const cronAge = doctorResult(invalidCron.stdout).checks.find(
        (check) => check.id === 'cron-age'
      );
      expect(cronAge?.ok).toBe('skipped');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('output streams', () => {
  test('sync sends progress to stderr as plain lines and leaves stdout empty', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });

      const result = await runCliIn(fx.work, 'sync');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('step: Fetching from upstream');
      expect(result.stderr).toContain('done: Fetched from all remotes');
      expect(result.stderr).not.toContain('\x1b');
    } finally {
      await fx.cleanup();
    }
  });

  test('a reader that closes stdout early gets no stack trace', async () => {
    const fx = await createMirrorFixture();
    try {
      for (const args of [['help'], ['doctor', '--json']]) {
        const stderrFile = path.join(tmp, 'epipe-stderr.txt');
        const shell = await $({
          cwd: fx.work,
          reject: false,
          env: { PATH: stubPath, STDERR_FILE: stderrFile },
        })`sh -c ${'node "$0" "$@" 2>"$STDERR_FILE" | (exec 0<&-; sleep 1)'} ${entry} ${args}`;
        expect(shell.exitCode).toBe(0);
        const stderr = await readFile(stderrFile, 'utf8');
        expect(stderr).not.toContain('EPIPE');
        expect(stderr).not.toContain('    at ');
      }
    } finally {
      await fx.cleanup();
    }
  });

  test('doctor --json keeps stdout to the JSON document', async () => {
    const fx = await createMirrorFixture();
    try {
      const result = await runCliIn(fx.work, 'doctor', '--json');

      expect(doctorResult(result.stdout).checks).toHaveLength(10);
      expect(doctorResult(result.stdout).healthy).toBe(true);
      expect(result.stderr).not.toContain('\x1b');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('--json envelope on stdout, no TTY', () => {
  test('sync: pushed, then up-to-date, with progress still on stderr', async () => {
    const fx = await createMirrorFixture();
    try {
      const upstreamTip = await fx.commitOnUpstream({ 'src/new.txt': 'new\n' });

      const first = await runCliWithoutTty(fx.work, ['sync', '--json']);
      expect(first.exitCode).toBe(0);
      expect(first.stderr).toContain('step: Fetching from upstream');
      expect(parseEnvelope(first.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        result: {
          kind: 'default-branch',
          status: 'pushed',
          branch: 'main',
          upstreamTip,
          origin: { tip: upstreamTip, pushed: true },
          public: { tip: upstreamTip, pushed: true },
        },
      });

      const second = await runCliWithoutTty(fx.work, ['sync', '--json']);
      expect(second.exitCode).toBe(0);
      expect(parseEnvelope(second.stdout)).toMatchObject({
        ok: true,
        result: {
          status: 'up-to-date',
          origin: { tip: upstreamTip, pushed: false },
          public: { tip: upstreamTip, pushed: false },
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('sync: divergence is a sync-divergence error, exit 1', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.commitOnOrigin({ 'src/hotfix.ts': 'export {};\n' });

      const result = await runCliWithoutTty(fx.work, ['sync', '--json']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Divergent commits detected');
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'sync-divergence',
          message: expect.stringContaining('Sync aborted to prevent data loss'),
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('stage: --json never prompts; without --yes it is missing-input, exit 2', async () => {
    const fx = await createMirrorFixture();
    try {
      await cutFeatureBranch(fx);
      const publicFork = fx.publicFork ?? '';

      const refused = await runCliWithoutTty(fx.work, [
        'stage',
        'feature',
        '--json',
      ]);
      expect(refused.timedOut).toBe(false);
      expect(refused.exitCode).toBe(2);
      expect(parseEnvelope(refused.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'missing-input',
          message: expect.stringContaining('Push to public fork?'),
          flag: '--yes',
        },
      });
      expect(await hasBranch(publicFork, 'feature')).toBe(false);

      const staged = await runCliWithoutTty(fx.work, [
        'stage',
        'feature',
        '--json',
        '--yes',
      ]);
      expect(staged.exitCode).toBe(0);
      expect(parseEnvelope(staged.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        result: {
          branch: 'feature',
          head: await fx.sha(publicFork, 'feature'),
          target: 'public',
          compareUrl: expect.stringContaining('feature?expand=1'),
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('doctor: unhealthy checks are ok: true with exit 1', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.commitOnOrigin({ 'src/hotfix.ts': 'export {};\n' });

      const result = await runCliWithoutTty(fx.work, ['doctor', '--json']);

      expect(result.exitCode).toBe(1);
      const envelope = parseEnvelope(result.stdout);
      expect(Object.keys(envelope).sort()).toEqual([
        'ok',
        'result',
        'schemaVersion',
      ]);
      const { checks, links, healthy } = envelope.result as {
        checks: Array<{ id: string; ok: unknown }>;
        links: unknown;
        healthy: unknown;
      };
      expect(healthy).toBe(false);
      expect(checks.find((check) => check.id === 'divergence')?.ok).toBe(false);
      expect(links).toEqual({
        shippedBranches: {},
        pulledPrs: {},
        shippedIssues: {},
        pulledIssues: {},
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('schedule: status, set and disable report the schedule', async () => {
    const fx = await createMirrorFixture();
    try {
      const run = async (args: string[]) => {
        const result = await runCliWithoutTty(fx.work, [
          'schedule',
          ...args,
          '--json',
        ]);
        expect(result.exitCode).toBe(0);
        return parseEnvelope(result.stdout);
      };

      expect(await run(['status'])).toEqual({
        schemaVersion: 1,
        ok: true,
        result: { enabled: false, auth: 'token' },
      });
      expect(await run(['set', '0 */6 * * *'])).toEqual({
        schemaVersion: 1,
        ok: true,
        result: { enabled: true, cron: '0 */6 * * *', auth: 'token' },
      });
      expect(await run(['disable'])).toEqual({
        schemaVersion: 1,
        ok: true,
        result: { enabled: false, cron: '0 */6 * * *', auth: 'token' },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('workflows: status and list edits report the policy', async () => {
    const fx = await createMirrorFixture();
    try {
      const run = async (args: string[]) => {
        const result = await runCliWithoutTty(fx.work, [
          'workflows',
          ...args,
          '--json',
        ]);
        expect(result.exitCode).toBe(0);
        return parseEnvelope(result.stdout).result;
      };

      expect(await run(['status'])).toEqual({
        mode: 'none',
        enabledWorkflows: [],
        disabledWorkflows: [],
      });
      expect(await run(['block', 'deploy.yml'])).toEqual({
        mode: 'block',
        enabledWorkflows: [],
        disabledWorkflows: ['deploy.yml'],
      });
      expect(await run(['allow', 'ci.yml'])).toEqual({
        mode: 'allow',
        enabledWorkflows: ['ci.yml'],
        disabledWorkflows: ['deploy.yml'],
      });
      expect(await run(['clear'])).toEqual({
        mode: 'none',
        enabledWorkflows: [],
        disabledWorkflows: [],
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('preserve: list reports valid and invalid entries; remove reports the list after it', async () => {
    const fx = await createMirrorFixture();
    try {
      await seedPreserve(fx, ['docs/MIRROR.md', '../escape.txt']);

      const listed = await runCliWithoutTty(fx.work, [
        'preserve',
        'list',
        '--json',
      ]);
      expect(listed.exitCode).toBe(0);
      expect(parseEnvelope(listed.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        result: { paths: ['docs/MIRROR.md'], invalidPaths: ['../escape.txt'] },
      });

      const removed = await runCliWithoutTty(fx.work, [
        'preserve',
        'remove',
        '../escape.txt',
        '--json',
      ]);
      expect(removed.exitCode).toBe(0);
      expect(parseEnvelope(removed.stdout).result).toEqual({
        paths: ['docs/MIRROR.md'],
        invalidPaths: [],
      });

      const unknown = await runCliWithoutTty(fx.work, [
        'preserve',
        'remove',
        'nope.txt',
        '--json',
      ]);
      expect(unknown.exitCode).toBe(1);
      expect(parseEnvelope(unknown.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'precondition',
          message: expect.stringContaining(
            "Not in the preserve list: 'nope.txt'"
          ),
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('a mirror without venfork-config is a config error, exit 1', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.git(fx.origin, 'branch', '-D', 'venfork-config');

      for (const args of [
        ['schedule', 'status', '--json'],
        ['workflows', 'status', '--json'],
        ['preserve', 'list', '--json'],
      ]) {
        const result = await runCliWithoutTty(fx.work, args);
        expect(result.exitCode).toBe(1);
        expect(parseEnvelope(result.stdout)).toEqual({
          schemaVersion: 1,
          ok: false,
          error: {
            code: 'config',
            message: 'venfork-config branch not found or invalid',
          },
        });
      }
    } finally {
      await fx.cleanup();
    }
  });

  test('setup: --json on a personal account is a missing-input envelope naming --yes', async () => {
    const result = await runCliWithoutTty(tmp, [
      'setup',
      'a/b',
      'b-private',
      '--json',
    ]);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(parseEnvelope(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'missing-input',
        message: expect.stringContaining('Continue with personal account?'),
        flag: '--yes',
      },
    });
  });

  for (const args of [
    ['sync', '--json', '--bogus'],
    ['stage', '--json'],
    ['pull', 'nope', '--json'],
    ['doctor', '--json', 'extra'],
    ['schedule', 'set', '--json'],
    ['workflows', 'allow', '--json'],
    ['preserve', 'bogus', '--json'],
    ['clone', '--json'],
  ]) {
    test(`usage error: venfork ${args.join(' ')} prints the usage envelope, exit 2`, async () => {
      const result = await runCliWithoutTty(tmp, args);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Error: ');
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: { code: 'usage', message: expect.any(String) },
      });
    });
  }

  for (const args of [
    ['pull', 'pr', '12', '--json'],
    ['sync', '--json'],
    ['stage', 'feature', '--yes', '--json'],
    ['schedule', 'status', '--json'],
    ['workflows', 'status', '--json'],
    ['preserve', 'list', '--json'],
  ]) {
    test(`outside a git repository, venfork ${args.join(' ')} is not-in-repository, exit 1`, async () => {
      const result = await runCliWithoutTty(tmp, args);

      expect(result.exitCode).toBe(1);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: { code: 'not-in-repository', message: expect.any(String) },
      });
    });
  }

  test('clone --json when gh repo clone fails is a github envelope, exit 1', async () => {
    const work = await mkdtemp(path.join(tmp, 'clone-fail-'));
    const result = await runCliWithoutTty(work, [
      'clone',
      'acme/proj-private',
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseEnvelope(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'github',
        message: expect.stringContaining('gh repo clone'),
      },
    });
  });

  test('an unknown command with --json prints the usage envelope, exit 2', async () => {
    const result = await runCliWithoutTty(tmp, ['bogus', '--json']);

    expect(result.exitCode).toBe(2);
    expect(parseEnvelope(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'usage', message: expect.stringContaining('bogus') },
    });
  });

  for (const args of [
    ['frob', '--json'],
    ['pull-request', '5', '--json'],
    ['--json', 'sync'],
    ['sync', '--json', '--help'],
    ['help', 'sync', '--json'],
    ['--version', '--json'],
  ]) {
    test(`venfork ${args.join(' ')} prints the usage envelope, exit 2`, async () => {
      const result = await runCliWithoutTty(tmp, args);

      expect(result.exitCode).toBe(2);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: { code: 'usage', message: expect.any(String) },
      });
    });
  }

  test('sync --json killed with SIGINT prints a cancelled envelope', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.git(
        fx.work,
        'remote',
        'set-url',
        'upstream',
        'ssh://git@example.invalid/client/project.git'
      );
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        PATH: authedPath,
        GIT_SSH_COMMAND: 'sleep 5 #',
      };
      delete childEnv.CI;
      delete childEnv.VENFORK_NONINTERACTIVE;
      const child = $({
        cwd: fx.work,
        reject: false,
        stdin: 'pipe',
        timeout: 20000,
        env: childEnv,
        extendEnv: false,
      })`node ${entry} sync --json`;
      await new Promise<void>((resolve) => {
        let seen = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          seen += chunk.toString();
          if (seen.includes('Fetching from upstream')) resolve();
        });
      });
      child.kill('SIGINT');
      const result = await child;

      expect(result.exitCode).toBe(130);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: { code: 'cancelled', message: 'Interrupted by SIGINT' },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('stage --yes --json of the default branch is a precondition envelope', async () => {
    const fx = await createMirrorFixture();
    try {
      const result = await runCliWithoutTty(fx.work, [
        'stage',
        'main',
        '--yes',
        '--json',
      ]);

      expect(result.exitCode).toBe(1);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'precondition',
          message: expect.stringContaining("it is upstream's default branch"),
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('stage --yes --json on a branch adding a preserved path is a stage-leak envelope, exit 1, public unchanged', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.commitOnOrigin(
        { '.venfork/config.json': '{}\n' },
        'chore: mirror-only file'
      );
      await fx.git(fx.work, 'checkout', '--quiet', '-b', 'leaky');
      await writeFile(path.join(fx.work, 'notes.md'), 'internal\n');
      await mkdir(path.join(fx.work, '.venfork'), { recursive: true });
      await writeFile(path.join(fx.work, '.venfork', 'leak.txt'), 'leak\n');
      await fx.git(fx.work, 'add', '.');
      await fx.git(fx.work, 'commit', '--quiet', '-m', 'feat: leaky change');
      const publicFork = fx.publicFork ?? '';
      const before = await fx.git(publicFork, 'for-each-ref');

      const result = await runCliWithoutTty(fx.work, [
        'stage',
        'leaky',
        '--yes',
        '--json',
      ]);

      expect(result.exitCode).toBe(1);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: { code: 'stage-leak', message: expect.any(String) },
      });
      expect(await fx.git(publicFork, 'for-each-ref')).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  test('stage --yes --json of a commit naming the mirror is a mirror-reference envelope, exit 1, public unchanged', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.git(fx.work, 'checkout', '--quiet', '-b', 'named');
      await writeFile(path.join(fx.work, 'named.txt'), 'x\n');
      await fx.git(fx.work, 'add', 'named.txt');
      await fx.git(
        fx.work,
        'commit',
        '--quiet',
        '-m',
        'feat: port the venfork mirror tweak'
      );
      const publicFork = fx.publicFork ?? '';
      const before = await fx.git(publicFork, 'for-each-ref');

      const result = await runCliWithoutTty(fx.work, [
        'stage',
        'named',
        '--yes',
        '--json',
      ]);

      expect(result.exitCode).toBe(1);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: { code: 'mirror-reference', message: expect.any(String) },
      });
      expect(await fx.git(publicFork, 'for-each-ref')).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  test('sync --json without a public remote is remote-not-found', async () => {
    const fx = await createMirrorFixture();
    try {
      await fx.git(fx.work, 'remote', 'remove', 'public');

      const result = await runCliWithoutTty(fx.work, ['sync', '--json']);

      expect(result.exitCode).toBe(1);
      expect(parseEnvelope(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'remote-not-found',
          message: expect.stringContaining("'public'"),
        },
      });
    } finally {
      await fx.cleanup();
    }
  });

  test('without gh on PATH, the error says gh is not installed', async () => {
    const bin = await mkdtemp(path.join(tmp, 'no-gh-'));
    for (const tool of ['node', 'git']) {
      await writeFile(
        path.join(bin, tool),
        `#!/bin/sh\nexec ${JSON.stringify(Bun.which(tool) ?? tool)} "$@"\n`
      );
      await chmod(path.join(bin, tool), 0o755);
    }
    const result = await $({
      cwd: tmp,
      reject: false,
      env: { PATH: bin },
      extendEnv: false,
    })`${path.join(bin, 'node')} ${entry} pull pr 12 --json`;

    expect(result.exitCode).toBe(1);
    expect(parseEnvelope(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'auth',
        message: expect.stringContaining('gh) is not installed'),
      },
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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
      expect(refused.stderr).toContain('--upstream <url>');
      expect(
        await stat(path.join(work, 'proj-private')).then(
          () => true,
          () => false
        )
      ).toBe(false);

      const cloned = await runCliWithoutTty(
        work,
        [
          'clone',
          'acme/proj-private',
          '--no-public',
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

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown option '--bogus'");
    expect(result.stdout).not.toContain('--bogus');
  });

  test('an unknown command is reported on stderr', async () => {
    const result = await runCli('frobnicate');

    expect(result.exitCode).toBe(1);
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

      expect(result.exitCode).toBe(1);
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

    expect(result.exitCode).toBe(1);
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

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(usage);
    });
  }
});

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
        const { checks } = JSON.parse(stdout) as {
          checks: Array<{ id: string; ok: unknown }>;
        };
        expect(checks[0].id).toBe('repo');
        expect(checks).toHaveLength(10);
      }
      const cronAge = (
        JSON.parse(invalidCron.stdout) as {
          checks: Array<{ id: string; ok: unknown }>;
        }
      ).checks.find((check) => check.id === 'cron-age');
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

      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stderr).not.toContain('\x1b');
    } finally {
      await fx.cleanup();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { createMirrorFixture } from '../harness/mirror-fixture.js';

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

describe('built CLI entry point', () => {
  test('--version prints the package version', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8')
    ) as { version: string };

    const result = await runCli('--version');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test('input that ends at a prompt exits 130 instead of 0', async () => {
    const result = await $({
      cwd: tmp,
      reject: false,
      stdin: { file: '/dev/null' },
      env: { PATH: authedPath },
    })`node ${entry} setup a/b --org c`;

    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe('Cancelled: input ended at a prompt');
    expect(result.stdout).toContain('Private mirror repo name?');
    expect(result.stdout).not.toContain('Cancelled');
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

  test('setup without gh auth exits 1 with the AuthenticationError message', async () => {
    const result = await runCli('setup');

    expect(result.exitCode).toBe(1);
    expect(result.all).toContain(
      'GitHub CLI is not authenticated. Please run: gh auth login'
    );
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

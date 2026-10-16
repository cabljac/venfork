import { describe, expect, test } from 'bun:test';
import { parseCloneCliArgs } from '../../src/clone-args.js';
import { parseDoctorCliArgs } from '../../src/doctor-args.js';
import {
  AuthenticationError,
  BranchNotFoundError,
  CommandExitError,
  ConfigError,
  exitCodeFor,
  GitError,
  GitHubError,
  MirrorReferenceError,
  MissingInputError,
  NotInRepositoryError,
  PinDowngradeError,
  PreconditionError,
  RedactionError,
  RemoteNotFoundError,
  StageLeakError,
  SyncDivergenceError,
  UnmigratedMirrorError,
  UsageError,
  VenforkError,
} from '../../src/errors.js';
import { parsePreserveCliArgs } from '../../src/preserve-args.js';
import { parsePullCliArgs } from '../../src/pull-args.js';
import { parseScheduleCliArgs } from '../../src/schedule-args.js';
import { parseSetupCliArgs } from '../../src/setup-args.js';
import {
  errorEnvelope,
  type JsonEnvelope,
  jsonRequested,
  successEnvelope,
  writeEnvelope,
} from '../../src/shared/json-output.js';
import { parseStageCliArgs } from '../../src/stage-args.js';
import { parseSyncCliArgs } from '../../src/sync-args.js';
import { parseWorkflowsCliArgs } from '../../src/workflows-args.js';

describe('error codes', () => {
  const none = { count: 0, files: [] };
  test.each([
    ['VenforkError', new VenforkError('x'), 'runtime'],
    ['AuthenticationError', new AuthenticationError(), 'auth'],
    ['GitError', new GitError('x', 'op'), 'git'],
    ['GitHubError', new GitHubError('x'), 'github'],
    ['PreconditionError', new PreconditionError('x'), 'precondition'],
    [
      'RemoteNotFoundError',
      new RemoteNotFoundError('origin'),
      'remote-not-found',
    ],
    ['NotInRepositoryError', new NotInRepositoryError(), 'not-in-repository'],
    ['BranchNotFoundError', new BranchNotFoundError('b'), 'branch-not-found'],
    [
      'SyncDivergenceError',
      new SyncDivergenceError('main', { count: 1, files: ['a'] }, none),
      'sync-divergence',
    ],
    ['ConfigError', new ConfigError('x'), 'config'],
    ['RedactionError', new RedactionError('x'), 'redaction'],
    [
      'MirrorReferenceError',
      new MirrorReferenceError('w', 'm', 'r'),
      'mirror-reference',
    ],
    ['StageLeakError', new StageLeakError('b', ['p']), 'stage-leak'],
    [
      'PinDowngradeError',
      new PinDowngradeError('2.0.0', '1.0.0'),
      'pin-downgrade',
    ],
    ['UnmigratedMirrorError', new UnmigratedMirrorError(), 'unmigrated-mirror'],
    ['CommandExitError(1)', new CommandExitError(1), 'command-failed'],
    ['CommandExitError(130)', new CommandExitError(130), 'cancelled'],
    [
      'MissingInputError',
      new MissingInputError('--yes', 'Push?'),
      'missing-input',
    ],
    ['UsageError', new UsageError('x'), 'usage'],
  ] as const)('%s has its stable code', (_name, error, code) => {
    expect(error.code).toBe(code);
  });

  test('exit codes follow the contract', () => {
    expect(exitCodeFor(new UsageError('x'))).toBe(2);
    expect(exitCodeFor(new MissingInputError('--yes', 'q'))).toBe(2);
    expect(exitCodeFor(new CommandExitError(130))).toBe(130);
    expect(exitCodeFor(new CommandExitError(1, new Error('x')))).toBe(1);
    expect(exitCodeFor(new GitError('x', 'op'))).toBe(1);
    expect(exitCodeFor(new Error('x'))).toBe(1);
  });
});

describe('envelopes', () => {
  test('success wraps the result', () => {
    expect(successEnvelope({ branch: 'main' })).toEqual({
      schemaVersion: 1,
      ok: true,
      result: { branch: 'main' },
    });
  });

  test('usage error', () => {
    expect(errorEnvelope(new UsageError("Unknown option '--x'"))).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'usage', message: "Unknown option '--x'" },
    });
  });

  test('missing input names the flag', () => {
    const error = new MissingInputError('--yes', 'Push to public fork?');
    expect(errorEnvelope(error)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'missing-input', message: error.message, flag: '--yes' },
    });
  });

  test('a command exit describes its cause', () => {
    const cause = new BranchNotFoundError('feat');
    expect(errorEnvelope(new CommandExitError(1, cause))).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'branch-not-found',
        message: "Branch 'feat' does not exist",
      },
    });
  });

  test('a non-venfork error is internal, with or without a command exit', () => {
    const internal: JsonEnvelope = {
      schemaVersion: 1,
      ok: false,
      error: { code: 'internal', message: 'boom' },
    };
    expect(errorEnvelope(new Error('boom'))).toEqual(internal);
    expect(errorEnvelope(new CommandExitError(1, new Error('boom')))).toEqual(
      internal
    );
  });

  test('errorEnvelope maps an ExecaError from gh to github', () => {
    const error = Object.assign(
      new Error('Command failed with exit code 1: gh repo view acme/x'),
      {
        command: 'gh repo view acme/x',
        shortMessage: 'Command failed with exit code 1: gh repo view acme/x',
        exitCode: 1,
      }
    );
    expect(errorEnvelope(error)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'github', message: error.message },
    });
  });

  test('errorEnvelope maps an ExecaError from git to git, also as a cause', () => {
    const error = Object.assign(
      new Error('Command failed with exit code 128: git fetch upstream'),
      {
        command: 'git -c credential.helper= fetch upstream',
        shortMessage: 'Command failed with exit code 128: git fetch upstream',
        exitCode: 128,
      }
    );
    const expected: JsonEnvelope = {
      schemaVersion: 1,
      ok: false,
      error: { code: 'git', message: error.message },
    };
    expect(errorEnvelope(error)).toEqual(expected);
    expect(errorEnvelope(new CommandExitError(1, error))).toEqual(expected);
  });

  test('a signal exit is cancelled', () => {
    expect(new CommandExitError(143).code).toBe('cancelled');
    expect(new CommandExitError(130).code).toBe('cancelled');
  });

  test('is written as one line of JSON and a newline', async () => {
    const chunks: string[] = [];
    await writeEnvelope(successEnvelope({ a: 1 }), {
      write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void) {
        chunks.push(String(chunk));
        cb?.();
        return true;
      },
    } as Pick<NodeJS.WritableStream, 'write'>);
    expect(chunks).toEqual([
      '{"schemaVersion":1,"ok":true,"result":{"a":1}}\n',
    ]);
  });
});

describe('jsonRequested', () => {
  test('for any command, so an unknown, renamed or misplaced one gets the envelope', () => {
    expect(jsonRequested('sync', ['--json'])).toBe(true);
    expect(jsonRequested('frob', ['--json'])).toBe(true);
    expect(jsonRequested('pull-request', ['5', '--json'])).toBe(true);
    expect(jsonRequested('--json', ['sync'])).toBe(true);
    expect(jsonRequested('sync', ['--json', '--help'])).toBe(true);
    expect(jsonRequested('sync', [])).toBe(false);
  });

  test('sees --json next to a usage error, so the error gets the envelope', () => {
    expect(jsonRequested('stage', ['--json', '--bogus'])).toBe(true);
    expect(jsonRequested('pull', ['nope', '--json'])).toBe(true);
    expect(() => parseStageCliArgs(['--json', '--bogus'])).toThrow(UsageError);
  });

  test('stops at --', () => {
    expect(jsonRequested('stage', ['--', '--json'])).toBe(false);
    expect(jsonRequested('preserve', ['add', '--', '--json'])).toBe(false);
  });

  const parsedJson: Record<string, (args: string[]) => boolean> = {
    sync: (args) => parseSyncCliArgs(args).json,
    stage: (args) => parseStageCliArgs(args).json,
    pull: (args) => parsePullCliArgs(args).json,
    doctor: (args) => parseDoctorCliArgs(args).json,
    setup: (args) => parseSetupCliArgs(args).json,
    clone: (args) => parseCloneCliArgs(args).json,
    schedule: (args) => parseScheduleCliArgs(args).json,
    workflows: (args) => parseWorkflowsCliArgs(args).json,
    preserve: (args) => parsePreserveCliArgs(args).json,
  };
  test.each([
    ['sync', []],
    ['sync', ['--json']],
    ['sync', ['main', '--report-issues', '--json']],
    ['stage', ['feat']],
    ['stage', ['feat', '--json', '--pr']],
    ['stage', ['branch', 'feat', '--json']],
    ['stage', ['issue', '7', '--json']],
    ['pull', ['pr', '12', '--json']],
    ['pull', ['pr', '12']],
    ['pull', ['issue', '3', '--json', '--yes']],
    ['doctor', ['--json']],
    ['doctor', []],
    ['setup', ['a/b', '--json']],
    ['setup', ['a/b', 'b-private', '--org', 'acme']],
    ['clone', ['acme/p-private', '--json']],
    ['clone', ['acme/p-private']],
    ['schedule', ['--json']],
    ['schedule', ['status', '--json']],
    ['schedule', ['set', '0 * * * *', '--app', '--json']],
    ['schedule', ['disable']],
    ['workflows', ['status', '--json']],
    ['workflows', ['allow', 'ci.yml', '--json']],
    ['workflows', []],
    ['preserve', ['--json']],
    ['preserve', ['add', 'a.txt', '--json']],
    ['preserve', ['add', '--', '--json']],
    ['preserve', ['list']],
  ] as const)('%s %p: the pre-scan agrees with the parser', (command, args) => {
    expect(jsonRequested(command, [...args])).toBe(
      parsedJson[command]([...args])
    );
  });

  test('--json implies --no-input wherever a command prompts', () => {
    const stage = parseStageCliArgs(['feat', '--json']);
    expect(stage.prompt).toEqual({ yes: false, noInput: true });
    const issue = parseStageCliArgs(['issue', '7', '--json', '--yes']);
    expect(issue.prompt).toEqual({ yes: true, noInput: true });
    const pull = parsePullCliArgs(['issue', '3', '--json']);
    expect(pull.kind === 'issue' && pull.prompt.noInput).toBe(true);
    expect(parseSetupCliArgs(['a/b', '--json', '-y']).prompt).toEqual({
      yes: true,
      noInput: true,
    });
    expect(parseCloneCliArgs(['acme/p-private', '--json']).prompt).toEqual({
      yes: false,
      noInput: true,
    });
  });
});

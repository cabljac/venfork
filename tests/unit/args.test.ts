import { describe, expect, test } from 'bun:test';
import { parseCloneCliArgs } from '../../src/clone-args.js';
import { parseDoctorCliArgs } from '../../src/doctor-args.js';
import { parsePreserveCliArgs } from '../../src/preserve-args.js';
import { parsePullCliArgs } from '../../src/pull-args.js';
import { parseScheduleCliArgs } from '../../src/schedule-args.js';
import { parseSetupCliArgs } from '../../src/setup-args.js';
import { parsePromptFlags, scanArgs } from '../../src/shared/args.js';
import { parseStageCliArgs } from '../../src/stage-args.js';
import { parseSyncCliArgs } from '../../src/sync-args.js';
import { parseWorkflowsCliArgs } from '../../src/workflows-args.js';

function scanWith(args: string[]) {
  const flags = parsePromptFlags({});
  const positional = scanArgs(args, 'usage', (a) => flags.onOption(a));
  return { prompt: flags.prompt, positional };
}

describe('parsePromptFlags', () => {
  test('defaults to neither flag', () => {
    expect(scanWith(['a'])).toEqual({
      prompt: { yes: false, noInput: false },
      positional: ['a'],
    });
  });

  test('reads --yes, -y and --no-input in any position', () => {
    expect(scanWith(['--yes', 'a', '--no-input']).prompt).toEqual({
      yes: true,
      noInput: true,
    });
    expect(scanWith(['a', '-y']).prompt).toEqual({
      yes: true,
      noInput: false,
    });
  });

  test('reads --no-input without --yes', () => {
    expect(scanWith(['--no-input']).prompt).toEqual({
      yes: false,
      noInput: true,
    });
  });

  test('treats the flags after -- as positionals', () => {
    expect(scanWith(['--', '--yes'])).toEqual({
      prompt: { yes: false, noInput: false },
      positional: ['--yes'],
    });
  });
});

describe('--no-input on every command', () => {
  const parsers: Array<[string, () => unknown]> = [
    ['setup', () => parseSetupCliArgs(['a/b', '--no-input'])],
    ['clone', () => parseCloneCliArgs(['a/b-private', '--no-input'])],
    ['sync', () => parseSyncCliArgs(['--no-input'])],
    ['schedule status', () => parseScheduleCliArgs(['status', '--no-input'])],
    ['workflows status', () => parseWorkflowsCliArgs(['--no-input'])],
    ['preserve list', () => parsePreserveCliArgs(['list', '--no-input'])],
    ['stage', () => parseStageCliArgs(['feat', '--no-input'])],
    ['pull pr', () => parsePullCliArgs(['pr', '12', '--no-input'])],
    ['pull issue', () => parsePullCliArgs(['issue', '12', '--no-input'])],
    ['doctor', () => parseDoctorCliArgs(['--no-input'])],
  ];
  for (const [name, parse] of parsers) {
    test(`${name} accepts --no-input`, () => {
      expect(parse).not.toThrow();
    });
  }
});

describe('--yes on every command', () => {
  const parsers: Array<[string, (flag: string) => unknown]> = [
    ['setup', (flag) => parseSetupCliArgs(['a/b', flag])],
    ['clone', (flag) => parseCloneCliArgs(['a/b-private', flag])],
    ['sync', (flag) => parseSyncCliArgs([flag])],
    ['schedule status', (flag) => parseScheduleCliArgs(['status', flag])],
    ['workflows status', (flag) => parseWorkflowsCliArgs([flag])],
    ['preserve list', (flag) => parsePreserveCliArgs(['list', flag])],
    ['stage', (flag) => parseStageCliArgs(['feat', flag])],
    ['pull pr', (flag) => parsePullCliArgs(['pr', '12', flag])],
    ['pull issue', (flag) => parsePullCliArgs(['issue', '12', flag])],
    ['doctor', (flag) => parseDoctorCliArgs([flag])],
  ];
  for (const [name, parse] of parsers) {
    test(`${name} accepts --yes and -y`, () => {
      expect(() => parse('--yes')).not.toThrow();
      expect(() => parse('-y')).not.toThrow();
    });
  }
});

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

function scanWith(args: string[], allowYes: boolean) {
  const flags = parsePromptFlags({ allowYes });
  const positional = scanArgs(args, 'usage', (a) => flags.onOption(a));
  return { prompt: flags.prompt, positional };
}

describe('parsePromptFlags', () => {
  test('defaults to neither flag', () => {
    expect(scanWith(['a'], true)).toEqual({
      prompt: { yes: false, noInput: false },
      positional: ['a'],
    });
  });

  test('reads --yes, -y and --no-input in any position', () => {
    expect(scanWith(['--yes', 'a', '--no-input'], true).prompt).toEqual({
      yes: true,
      noInput: true,
    });
    expect(scanWith(['a', '-y'], true).prompt).toEqual({
      yes: true,
      noInput: false,
    });
  });

  test('leaves --yes and -y unknown when the command has no confirm', () => {
    expect(() => scanWith(['--yes'], false)).toThrow("Unknown option '--yes'");
    expect(() => scanWith(['-y'], false)).toThrow("Unknown option '-y'");
    expect(scanWith(['--no-input'], false).prompt.noInput).toBe(true);
  });

  test('treats the flags after -- as positionals', () => {
    expect(scanWith(['--', '--yes'], true)).toEqual({
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

  test('--yes stays refused where nothing confirms', () => {
    expect(() => parsePullCliArgs(['pr', '12', '--yes'])).toThrow(
      "Unknown option '--yes'"
    );
    expect(() => parseSyncCliArgs(['--yes'])).toThrow("Unknown option '--yes'");
  });
});

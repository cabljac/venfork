import { describe, expect, test } from 'bun:test';
import { parseCloneCliArgs } from '../../src/clone-args.js';
import { parseDoctorCliArgs } from '../../src/doctor-args.js';
import { UsageError } from '../../src/errors.js';
import { parseKeepCliArgs } from '../../src/keep-args.js';
import { parsePullCliArgs } from '../../src/pull-args.js';
import { parseScheduleCliArgs } from '../../src/schedule-args.js';
import { parseSetupCliArgs } from '../../src/setup-args.js';
import { parseStageCliArgs } from '../../src/stage-args.js';
import { parseSyncCliArgs } from '../../src/sync-args.js';
import { parseWorkflowsCliArgs } from '../../src/workflows-args.js';

const cases: ReadonlyArray<
  readonly [string, (args: string[]) => unknown, string[], string]
> = [
  ['setup', parseSetupCliArgs, ['a/b', '--bogus'], "Unknown option '--bogus'"],
  ['setup', parseSetupCliArgs, ['a/b', 'c', 'd'], "Unexpected argument 'd'"],
  ['setup', parseSetupCliArgs, ['a/b', '--org'], '--org requires a value'],
  [
    'setup',
    parseSetupCliArgs,
    ['a/b', '--own-upstream', '--fork-name', 'x'],
    'cannot be combined',
  ],
  ['clone', parseCloneCliArgs, [], 'Missing mirror repository'],
  [
    'clone',
    parseCloneCliArgs,
    ['a/b', '--own-upstream', '--public-fork', 'c/d'],
    '--public-fork cannot be combined with --own-upstream',
  ],
  ['sync', parseSyncCliArgs, ['--bogus'], "Unknown option '--bogus'"],
  ['sync', parseSyncCliArgs, ['a', 'b'], 'Usage: venfork sync'],
  ['schedule', parseScheduleCliArgs, ['set'], 'Missing cron expression'],
  [
    'schedule',
    parseScheduleCliArgs,
    ['nope'],
    "Unknown schedule action 'nope'",
  ],
  [
    'schedule',
    parseScheduleCliArgs,
    ['set', '* * * * *', '--app', '--token'],
    'cannot be used together',
  ],
  ['stage', parseStageCliArgs, [], 'Missing branch name'],
  ['stage', parseStageCliArgs, ['b', '--internal-pr', '0'], 'positive integer'],
  ['stage', parseStageCliArgs, ['issue', 'abc'], 'Could not parse issue'],
  ['stage', parseStageCliArgs, ['issue', '1', '--pr'], 'only applies'],
  ['pull', parsePullCliArgs, [], 'Missing pull target'],
  ['pull', parsePullCliArgs, ['nope'], 'Unknown pull target'],
  ['pull', parsePullCliArgs, ['pr', 'abc'], 'Could not parse PR reference'],
  ['pull', parsePullCliArgs, ['issue', 'abc'], 'Could not parse issue'],
  ['doctor', parseDoctorCliArgs, ['--bogus'], "Unknown option '--bogus'"],
  ['workflows', parseWorkflowsCliArgs, ['nope'], 'Usage: venfork workflows'],
  ['workflows', parseWorkflowsCliArgs, ['allow'], 'Usage: venfork workflows'],
  ['keep', parseKeepCliArgs, ['nope'], 'Usage: venfork keep'],
  ['keep', parseKeepCliArgs, ['add'], 'Usage: venfork keep'],
  [
    'schedule',
    parseScheduleCliArgs,
    ['set', 'not a cron'],
    "Invalid cron expression 'not a cron'",
  ],
  [
    'sync',
    parseSyncCliArgs,
    ['--bogus'],
    'Usage: venfork sync [--report-issues] [--no-input] [--json]',
  ],
  [
    'doctor',
    parseDoctorCliArgs,
    ['--bogus'],
    'Usage: venfork doctor [--no-input] [--json]',
  ],
  [
    'schedule',
    parseScheduleCliArgs,
    ['--bogus'],
    '|disable> [--no-input] [--json]',
  ],
  [
    'workflows',
    parseWorkflowsCliArgs,
    ['nope'],
    '[workflow-file ...] [--no-input] [--json]',
  ],
  ['keep', parseKeepCliArgs, ['nope'], '[path ...] [--no-input] [--json]'],
  [
    'pull',
    parsePullCliArgs,
    ['pr', '1', '--bogus'],
    '[--no-push] [--no-input] [--json]',
  ],
];

describe('arg parsers throw UsageError', () => {
  for (const [command, parse, args, message] of cases) {
    test(`${command} ${args.join(' ') || '(no args)'}`, () => {
      let thrown: unknown;
      try {
        parse(args);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as Error).message).toContain(message);
    });
  }
});

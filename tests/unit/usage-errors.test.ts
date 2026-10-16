import { describe, expect, test } from 'bun:test';
import { parseCloneCliArgs } from '../../src/clone-args.js';
import { parseDoctorCliArgs } from '../../src/doctor-args.js';
import { UsageError } from '../../src/errors.js';
import { parsePreserveCliArgs } from '../../src/preserve-args.js';
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
    ['a/b', '--no-public', '--fork-name', 'x'],
    'cannot be combined',
  ],
  ['clone', parseCloneCliArgs, [], 'Missing vendor repository'],
  [
    'clone',
    parseCloneCliArgs,
    ['a/b', '--no-public', '--public-fork', 'c/d'],
    '--public-fork cannot be combined with --no-public',
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
  ['preserve', parsePreserveCliArgs, ['nope'], 'Usage: venfork preserve'],
  ['preserve', parsePreserveCliArgs, ['add'], 'Usage: venfork preserve'],
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

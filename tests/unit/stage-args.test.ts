import { describe, expect, test } from 'bun:test';
import {
  type ParsedStageArgs,
  type ParsedStageBranchArgs,
  parseStageCliArgs as parseStageUnion,
} from '../../src/stage-args.js';

function parseStageCliArgs(args: string[]): ParsedStageBranchArgs {
  const parsed = parseStageUnion(args);
  if (parsed.kind !== 'branch') throw new Error('expected a branch parse');
  return parsed;
}

describe('parseStageCliArgs', () => {
  test('parses positional branch with no flags: the PR is opened by default', () => {
    const parsed = parseStageCliArgs(['feat/auth']);
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.createPr).toBe(true);
    expect(parsed.draft).toBe(false);
    expect(parsed.title).toBeUndefined();
    expect(parsed.base).toBeUndefined();
  });

  test('--pr is still accepted and changes nothing', () => {
    const parsed = parseStageCliArgs(['feat/auth', '--pr']);
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.createPr).toBe(true);
    expect(parsed.draft).toBe(false);
  });

  test('--draft implies --pr', () => {
    const parsed = parseStageCliArgs(['feat/auth', '--draft']);
    expect(parsed.createPr).toBe(true);
    expect(parsed.draft).toBe(true);
  });

  test('parses --title and --base value forms', () => {
    const parsed = parseStageCliArgs([
      'feat/auth',
      '--pr',
      '--title',
      'Add auth',
      '--base',
      'develop',
    ]);
    expect(parsed.title).toBe('Add auth');
    expect(parsed.base).toBe('develop');
  });

  test('parses --title= and --base= forms', () => {
    const parsed = parseStageCliArgs([
      'feat/auth',
      '--pr',
      '--title=Add auth',
      '--base=develop',
    ]);
    expect(parsed.title).toBe('Add auth');
    expect(parsed.base).toBe('develop');
  });

  test('throws when --title has no value', () => {
    expect(() => parseStageCliArgs(['feat/auth', '--pr', '--title'])).toThrow(
      '--title requires a value'
    );
  });

  test('throws when --title= is empty', () => {
    expect(() => parseStageCliArgs(['feat/auth', '--pr', '--title='])).toThrow(
      '--title requires a value'
    );
  });

  test('throws when --base has no value', () => {
    expect(() => parseStageCliArgs(['feat/auth', '--pr', '--base'])).toThrow(
      '--base requires a value'
    );
  });

  test('flag order does not matter; positional can come last', () => {
    const parsed = parseStageCliArgs(['--pr', '--draft', 'feat/auth']);
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.createPr).toBe(true);
    expect(parsed.draft).toBe(true);
  });

  test('--internal-pr <n> sets internalPrNumber', () => {
    const parsed = parseStageCliArgs([
      'feat/auth',
      '--pr',
      '--internal-pr',
      '42',
    ]);
    expect(parsed.internalPrNumber).toBe(42);
  });

  test('--internal-pr=<n> form', () => {
    const parsed = parseStageCliArgs(['feat/auth', '--pr', '--internal-pr=42']);
    expect(parsed.internalPrNumber).toBe(42);
  });

  test('throws when --internal-pr is not a positive integer', () => {
    expect(() =>
      parseStageCliArgs(['feat/auth', '--pr', '--internal-pr', 'abc'])
    ).toThrow('--internal-pr requires a positive integer');
    expect(() =>
      parseStageCliArgs(['feat/auth', '--pr', '--internal-pr', '0'])
    ).toThrow('--internal-pr requires a positive integer');
  });

  test('--no-update-existing flips the body re-sync default', () => {
    const parsed = parseStageCliArgs([
      'feat/auth',
      '--pr',
      '--no-update-existing',
    ]);
    expect(parsed.noUpdateExisting).toBe(true);
  });

  test('noUpdateExisting defaults to false', () => {
    const parsed = parseStageCliArgs(['feat/auth', '--pr']);
    expect(parsed.noUpdateExisting).toBe(false);
  });

  test('bare form is a branch parse', () => {
    expect(parseStageUnion(['feat/auth']).kind).toBe('branch');
  });

  test('`stage branch <name>` stages a branch with flags', () => {
    const parsed = parseStageCliArgs(['branch', 'feat/auth', '--pr']);
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.createPr).toBe(true);
  });

  test('`stage branch issue` stages a branch named issue', () => {
    expect(parseStageCliArgs(['branch', 'issue']).branch).toBe('issue');
    expect(parseStageCliArgs(['branch', 'branch']).branch).toBe('branch');
  });

  test('bare `stage issue` refuses and points at `stage branch issue`', () => {
    expect(() => parseStageUnion(['issue'])).toThrow(
      'venfork stage branch issue'
    );
    expect(() => parseStageUnion(['issue', '--pr'])).toThrow(
      'venfork stage branch issue'
    );
  });

  test('bare `stage branch` refuses and points at `stage branch branch`', () => {
    expect(() => parseStageUnion(['branch'])).toThrow(
      'venfork stage branch branch'
    );
  });
});

describe('parseStageCliArgs issue', () => {
  test('parses `issue <n>`', () => {
    const parsed: ParsedStageArgs = parseStageUnion(['issue', '7']);
    expect(parsed).toEqual({
      kind: 'issue',
      ref: '7',
      title: undefined,
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('parses --title in both forms', () => {
    expect(parseStageUnion(['issue', '7', '--title', 'Override'])).toEqual({
      kind: 'issue',
      ref: '7',
      title: 'Override',
      prompt: { yes: false, noInput: false },
      json: false,
    });
    expect(parseStageUnion(['issue', '7', '--title=Override'])).toEqual({
      kind: 'issue',
      ref: '7',
      title: 'Override',
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('throws when --title has no value', () => {
    expect(() => parseStageUnion(['issue', '7', '--title'])).toThrow(
      '--title requires a value'
    );
  });
});

describe('parseStageCliArgs --no-pr', () => {
  test('--no-pr pushes the branch only', () => {
    expect(parseStageCliArgs(['feat', '--no-pr']).createPr).toBe(false);
  });

  test('--base still applies with --no-pr: it sets the compare link', () => {
    expect(parseStageCliArgs(['feat', '--no-pr', '--base', 'dev']).base).toBe(
      'dev'
    );
  });

  const prOnly: string[][] = [
    ['--draft'],
    ['--title', 'T'],
    ['--internal-pr', '3'],
    ['--no-update-existing'],
    ['--pr'],
  ];
  for (const flags of prOnly) {
    test(`refuses ${flags[0]} with --no-pr`, () => {
      expect(() => parseStageCliArgs(['feat', '--no-pr', ...flags])).toThrow(
        `${flags[0]} needs the upstream PR, so it cannot be combined with --no-pr`
      );
    });
  }
});

describe('parseStageCliArgs --dry-run', () => {
  test('is off by default', () => {
    expect(parseStageCliArgs(['feat']).dryRun).toBe(false);
  });

  test('works with the default PR and with --no-pr', () => {
    expect(parseStageCliArgs(['feat', '--dry-run']).dryRun).toBe(true);
    const offline = parseStageCliArgs(['feat', '--dry-run', '--no-pr']);
    expect(offline.dryRun).toBe(true);
    expect(offline.createPr).toBe(false);
  });
});

describe('parseStageCliArgs issue rejects branch-only flags', () => {
  const cases: string[][] = [
    ['--dry-run'],
    ['--pr'],
    ['--no-pr'],
    ['--draft'],
    ['--base', 'develop'],
    ['--internal-pr', '3'],
    ['--no-update-existing'],
  ];
  for (const flags of cases) {
    test(`refuses ${flags[0]} on stage issue`, () => {
      expect(() => parseStageCliArgs(['issue', '12', ...flags])).toThrow(
        /only applies to stage branch/
      );
    });
  }
});

describe('parseStageCliArgs strictness', () => {
  test('rejects an unknown flag after the branch', () => {
    expect(() => parseStageUnion(['feat', '--drfat'])).toThrow(
      "Unknown option '--drfat'. Usage: venfork stage"
    );
  });

  test('rejects an unknown flag instead of treating it as the branch', () => {
    expect(() => parseStageUnion(['--bogus'])).toThrow(
      "Unknown option '--bogus'"
    );
  });

  test('rejects an extra positional', () => {
    expect(() => parseStageUnion(['feat', 'extra'])).toThrow(
      "Unexpected argument 'extra'. Usage: venfork stage"
    );
    expect(() => parseStageUnion(['branch', 'feat', 'extra'])).toThrow(
      "Unexpected argument 'extra'"
    );
    expect(() => parseStageUnion(['issue', '5', 'extra'])).toThrow(
      "Unexpected argument 'extra'"
    );
  });

  test('accepts flags before the branch', () => {
    const parsed = parseStageCliArgs(['--pr', '--title=T', 'feat']);
    expect(parsed.branch).toBe('feat');
    expect(parsed.createPr).toBe(true);
    expect(parsed.title).toBe('T');
  });

  test('-- ends options so a dash-leading branch is accepted', () => {
    expect(parseStageCliArgs(['--', '-odd']).branch).toBe('-odd');
  });

  test('missing value at the end of argv throws', () => {
    for (const flag of ['--title', '--base', '--internal-pr']) {
      expect(() => parseStageUnion(['feat', flag])).toThrow(
        `${flag} requires a value`
      );
    }
  });

  test('--internal-pr takes only plain positive integers', () => {
    for (const bad of ['1e3', '0x10', ' 7 ', '0', '-1', '1.5']) {
      expect(() => parseStageUnion(['feat', `--internal-pr=${bad}`])).toThrow(
        '--internal-pr requires a positive integer'
      );
    }
    expect(
      parseStageCliArgs(['feat', '--internal-pr', '7']).internalPrNumber
    ).toBe(7);
  });
});

describe('parseStageCliArgs missing branch', () => {
  test('throws a usage error when no branch is given', () => {
    expect(() => parseStageUnion([])).toThrow(
      'Missing branch name. Usage: venfork stage <branch>'
    );
    expect(() => parseStageUnion(['--pr'])).toThrow('Missing branch name');
  });
});

describe('parseStageCliArgs prompt flags', () => {
  test('stage branch reads --yes, -y and --no-input', () => {
    expect(parseStageUnion(['feat', '--yes']).prompt).toEqual({
      yes: true,
      noInput: false,
    });
    expect(parseStageUnion(['-y', '--no-input', 'feat']).prompt).toEqual({
      yes: true,
      noInput: true,
    });
  });

  test('stage issue reads --yes and --no-input', () => {
    expect(parseStageUnion(['issue', '7', '--yes', '--no-input'])).toEqual({
      kind: 'issue',
      ref: '7',
      title: undefined,
      prompt: { yes: true, noInput: true },
      json: false,
    });
  });
});

describe('parseStageCliArgs: stage approval', () => {
  test('bare `stage approval` asks for the current level', () => {
    expect(parseStageUnion(['approval'])).toEqual({
      kind: 'approval',
      prompt: { yes: false, noInput: false },
      json: false,
    });
  });

  test('`on` means two-person; each level parses as itself', () => {
    for (const [word, level] of [
      ['on', 'two-person'],
      ['two-person', 'two-person'],
      ['reviewed', 'reviewed'],
      ['off', 'off'],
    ] as const) {
      expect(parseStageUnion(['approval', word, '--json'])).toEqual({
        kind: 'approval',
        level,
        prompt: { yes: false, noInput: true },
        json: true,
      });
    }
  });

  test('an unknown level is a usage error naming the explicit branch form', () => {
    expect(() => parseStageUnion(['approval', 'maybe'])).toThrow(
      "Unknown approval level 'maybe'"
    );
    expect(() => parseStageUnion(['approval', 'maybe'])).toThrow(
      'venfork stage branch approval'
    );
    expect(() => parseStageUnion(['approval', 'constructor'])).toThrow(
      "Unknown approval level 'constructor'"
    );
  });

  test('branch flags and a second level are usage errors', () => {
    expect(() => parseStageUnion(['approval', 'on', '--draft'])).toThrow(
      '--draft only applies to stage branch, not stage approval'
    );
    expect(() => parseStageUnion(['approval', '--title', 'x'])).toThrow(
      '--title only applies to stage branch, not stage approval'
    );
    expect(() => parseStageUnion(['approval', 'on', 'off'])).toThrow(
      "Unexpected argument 'off'"
    );
  });

  test('a branch flag names the explicit form for a branch named approval', () => {
    for (const argv of [
      ['approval', 'on', '--pr'],
      ['approval', '--draft'],
      ['approval', '--title', 'x'],
    ]) {
      expect(() => parseStageUnion(argv)).toThrow(
        "To stage a branch named 'approval', run `venfork stage branch approval`."
      );
    }
  });

  test('`stage branch approval` stages a branch named approval', () => {
    expect(parseStageCliArgs(['branch', 'approval']).branch).toBe('approval');
  });
});

describe('parseStageCliArgs: --force', () => {
  test('--force parses on a branch stage, with or without --no-pr', () => {
    expect(parseStageCliArgs(['feat/auth']).force).toBe(false);
    expect(parseStageCliArgs(['feat/auth', '--force']).force).toBe(true);
    expect(parseStageCliArgs(['feat/auth', '--force', '--no-pr']).force).toBe(
      true
    );
  });

  test('--force with --dry-run, stage issue or stage approval is a usage error', () => {
    expect(() =>
      parseStageUnion(['feat/auth', '--force', '--dry-run'])
    ).toThrow('--force cannot be combined with --dry-run');
    expect(() => parseStageUnion(['issue', '7', '--force'])).toThrow(
      '--force only applies to stage branch, not stage issue'
    );
    expect(() => parseStageUnion(['approval', '--force'])).toThrow(
      '--force only applies to stage branch, not stage approval'
    );
  });
});

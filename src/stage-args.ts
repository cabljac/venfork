import type { ApprovalLevel } from './config.js';
import { UsageError } from './errors.js';
import {
  consumeValue,
  parseGitHubRef,
  parsePositiveInt,
  parsePromptFlags,
  scanArgs,
  unexpectedArgument,
} from './shared/args.js';
import type { PromptContext } from './shared/prompt.js';

/** Parsed `venfork stage [branch] <name> ...` arguments. */
export type ParsedStageBranchArgs = {
  kind: 'branch';
  branch: string;
  /** Open the upstream PR after the push; false only with `--no-pr`. */
  createPr: boolean;
  /** When true, the upstream PR is opened as a draft. */
  draft: boolean;
  /** Override the upstream PR title; default is the internal PR title. */
  title?: string;
  /** Override the upstream base branch; default is upstream's default branch. */
  base?: string;
  /**
   * Pin the internal review PR by number, instead of letting venfork pick
   * the most recent one for the branch. Use when a branch has had multiple
   * internal PRs and you want to ship from a specific one.
   */
  internalPrNumber?: number;
  /**
   * When true, don't update an existing upstream PR body on re-runs.
   * Default behaviour re-syncs the body via `gh pr edit` so addressing
   * internal review feedback re-publishes upstream.
   */
  noUpdateExisting: boolean;
  /** `--dry-run`: show what would be published and push nothing. */
  dryRun: boolean;
  /** `--yes` / `--no-input`. */
  prompt: PromptContext;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

/** Parsed `venfork stage issue ...` arguments. */
export type ParsedStageIssueArgs = {
  kind: 'issue';
  /** Internal issue number or URL. */
  ref: string;
  /** Override the upstream issue title. */
  title?: string;
  /** `--yes` / `--no-input`. */
  prompt: PromptContext;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

/** Parsed `venfork stage approval [level]` arguments. */
export type ParsedStageApprovalArgs = {
  kind: 'approval';
  /** The level to set; absent prints the current level. `on` is `two-person`. */
  level?: ApprovalLevel;
  /** `--yes` / `--no-input`. */
  prompt: PromptContext;
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

export type ParsedStageArgs =
  | ParsedStageBranchArgs
  | ParsedStageIssueArgs
  | ParsedStageApprovalArgs;

/** Usage line for `venfork stage approval`. */
export const STAGE_APPROVAL_USAGE =
  'venfork stage approval [on|reviewed|two-person|off] [--yes] [--no-input] [--json]';

const APPROVAL_WORDS: Record<string, ApprovalLevel> = {
  on: 'two-person',
  'two-person': 'two-person',
  reviewed: 'reviewed',
  off: 'off',
};

/** Usage line for `venfork stage <branch>`. */
export const STAGE_USAGE =
  'venfork stage <branch> [--no-pr] [--draft] [--dry-run] [--title <text>] [--base <branch>] [--internal-pr <n>] [--no-update-existing] [--yes] [--no-input] [--json]';

/**
 * Parse `venfork stage ...` argv after the `stage` token.
 * Forms: `stage <branch>`, `stage branch <name>`, `stage issue <n-or-url>`,
 * `stage approval [level]`. The first positional selects the form, so a
 * branch named `issue`, `approval` or `branch` must use `stage branch <name>`.
 */
export function parseStageCliArgs(stageArgs: string[]): ParsedStageArgs {
  let prFlag: string | undefined;
  let noPr = false;
  let draft = false;
  let titleFlag: string | undefined;
  let title: string | undefined;
  let base: string | undefined;
  let internalPrNumber: number | undefined;
  let noUpdateExisting = false;
  let dryRun = false;
  const promptFlags = parsePromptFlags({ allowJson: true });

  const positional = scanArgs(stageArgs, STAGE_USAGE, (a, i) => {
    if (promptFlags.onOption(a) !== undefined) return 0;
    if (a === '--pr') {
      prFlag = a;
      return 0;
    }
    if (a === '--no-pr') {
      noPr = true;
      return 0;
    }
    if (a === '--draft') {
      draft = true;
      return 0;
    }
    if (a === '--no-update-existing') {
      noUpdateExisting = true;
      return 0;
    }
    if (a === '--dry-run') {
      dryRun = true;
      return 0;
    }
    if (a === '--title' || a.startsWith('--title=')) {
      const { value, consumed } = consumeValue('--title', stageArgs, i);
      title = value;
      titleFlag = '--title';
      return consumed;
    }
    if (a === '--base' || a.startsWith('--base=')) {
      const { value, consumed } = consumeValue('--base', stageArgs, i);
      base = value;
      return consumed;
    }
    if (a === '--internal-pr' || a.startsWith('--internal-pr=')) {
      const { value, consumed } = consumeValue('--internal-pr', stageArgs, i);
      const parsed = parsePositiveInt(value);
      if (parsed === null) {
        throw new UsageError('--internal-pr requires a positive integer');
      }
      internalPrNumber = parsed;
      return consumed;
    }
    return undefined;
  });

  const [first, ...rest] = positional;
  const branchFlags = [
    dryRun && '--dry-run',
    prFlag,
    noPr && '--no-pr',
    draft && '--draft',
    base !== undefined && '--base',
    internalPrNumber !== undefined && '--internal-pr',
    noUpdateExisting && '--no-update-existing',
  ].filter((flag): flag is string => typeof flag === 'string');
  if (first === 'approval') {
    const used = [...branchFlags, ...(titleFlag ? [titleFlag] : [])];
    if (used.length > 0) {
      throw new UsageError(
        `${used.join(', ')} only applies to stage branch, not stage approval. To stage a branch named 'approval', run \`venfork stage branch approval\`.`
      );
    }
    if (rest.length > 1)
      throw unexpectedArgument(rest[1], STAGE_APPROVAL_USAGE);
    const word = rest[0];
    const level = word === undefined ? undefined : APPROVAL_WORDS[word];
    if (word !== undefined && level === undefined) {
      throw new UsageError(
        `Unknown approval level '${word}'. Usage: ${STAGE_APPROVAL_USAGE}. To stage a branch named 'approval', run \`venfork stage branch approval\`.`
      );
    }
    return {
      kind: 'approval',
      ...(level ? { level } : {}),
      prompt: promptFlags.prompt,
      json: promptFlags.json,
    };
  }
  if (first === 'issue') {
    if (rest.length === 0) {
      throw new UsageError(
        "venfork stage issue requires an issue number or URL. To stage a branch named 'issue', run `venfork stage branch issue`."
      );
    }
    const branchOnly = branchFlags;
    if (branchOnly.length > 0) {
      throw new UsageError(
        `${branchOnly.join(', ')} only applies to stage branch, not stage issue`
      );
    }
    if (rest.length > 1) throw unexpectedArgument(rest[1], STAGE_USAGE);
    parseGitHubRef(rest[0], 'issues');
    return {
      kind: 'issue',
      ref: rest[0],
      title,
      prompt: promptFlags.prompt,
      json: promptFlags.json,
    };
  }

  let branch = first;
  if (first === 'branch') {
    if (rest.length === 0) {
      throw new UsageError(
        "venfork stage branch requires a branch name. To stage a branch named 'branch', run `venfork stage branch branch`."
      );
    }
    branch = rest[0];
  }
  const extra = first === 'branch' ? rest[1] : rest[0];
  if (extra !== undefined) throw unexpectedArgument(extra, STAGE_USAGE);

  if (branch === undefined) {
    throw new UsageError(`Missing branch name. Usage: ${STAGE_USAGE}`);
  }
  if (noPr) {
    const prOnly = [
      draft && '--draft',
      titleFlag,
      internalPrNumber !== undefined && '--internal-pr',
      noUpdateExisting && '--no-update-existing',
      prFlag,
    ].find((flag): flag is string => typeof flag === 'string');
    if (prOnly) {
      throw new UsageError(
        `${prOnly} needs the upstream PR, so it cannot be combined with --no-pr`
      );
    }
  }

  return {
    kind: 'branch',
    branch,
    createPr: !noPr,
    draft,
    title,
    base,
    internalPrNumber,
    noUpdateExisting,
    dryRun,
    prompt: promptFlags.prompt,
    json: promptFlags.json,
  };
}

import { consumeValue } from './shared/args.js';

/** Parsed `venfork stage [branch] <name> ...` arguments. */
export type ParsedStageBranchArgs = {
  kind: 'branch';
  branch?: string;
  /** When true, also open an upstream PR after staging. */
  createPr: boolean;
  /** When true, the upstream PR is opened as a draft. Implies --pr. */
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
};

/** Parsed `venfork stage issue ...` arguments. */
export type ParsedStageIssueArgs = {
  kind: 'issue';
  /** Internal issue number or URL. */
  ref: string;
  /** Override the upstream issue title. */
  title?: string;
};

export type ParsedStageArgs = ParsedStageBranchArgs | ParsedStageIssueArgs;

/**
 * Parse `venfork stage ...` argv after the `stage` token.
 * Forms: `stage <branch>`, `stage branch <name>`, `stage issue <n-or-url>`.
 * The first positional selects the form, so a branch named `issue` or
 * `branch` must use `stage branch <name>`.
 */
export function parseStageCliArgs(stageArgs: string[]): ParsedStageArgs {
  const positional: string[] = [];
  let createPr = false;
  let draft = false;
  let title: string | undefined;
  let base: string | undefined;
  let internalPrNumber: number | undefined;
  let noUpdateExisting = false;

  for (let i = 0; i < stageArgs.length; i++) {
    const a = stageArgs[i];
    if (a === '--pr') {
      createPr = true;
      continue;
    }
    if (a === '--draft') {
      draft = true;
      createPr = true;
      continue;
    }
    if (a === '--no-update-existing') {
      noUpdateExisting = true;
      continue;
    }
    if (a === '--title' || a.startsWith('--title=')) {
      const { value, consumed } = consumeValue('--title', stageArgs, i);
      title = value;
      i += consumed;
      continue;
    }
    if (a === '--base' || a.startsWith('--base=')) {
      const { value, consumed } = consumeValue('--base', stageArgs, i);
      base = value;
      i += consumed;
      continue;
    }
    if (a === '--internal-pr' || a.startsWith('--internal-pr=')) {
      const { value, consumed } = consumeValue('--internal-pr', stageArgs, i);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--internal-pr requires a positive integer');
      }
      internalPrNumber = parsed;
      i += consumed;
      continue;
    }
    positional.push(a);
  }

  const [first, ...rest] = positional;
  if (first === 'issue') {
    if (rest.length === 0) {
      throw new Error(
        "venfork stage issue requires an issue number or URL. To stage a branch named 'issue', run `venfork stage branch issue`."
      );
    }
    const branchOnly = [
      createPr && '--pr',
      draft && '--draft',
      base !== undefined && '--base',
      internalPrNumber !== undefined && '--internal-pr',
      noUpdateExisting && '--no-update-existing',
    ].filter((flag): flag is string => typeof flag === 'string');
    if (branchOnly.length > 0) {
      throw new Error(
        `${branchOnly.join(', ')} only applies to stage branch, not stage issue`
      );
    }
    return { kind: 'issue', ref: rest[0], title };
  }

  let branch = first;
  if (first === 'branch') {
    if (rest.length === 0) {
      throw new Error(
        "venfork stage branch requires a branch name. To stage a branch named 'branch', run `venfork stage branch branch`."
      );
    }
    branch = rest[0];
  }

  return {
    kind: 'branch',
    branch,
    createPr,
    draft,
    title,
    base,
    internalPrNumber,
    noUpdateExisting,
  };
}

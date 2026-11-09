import { $ } from 'execa';
import type { TrackedBranch } from '../config.js';
import { ConfigError, PreconditionError } from '../errors.js';
import { pushBranchWithLease, resolveCommit } from './mirror-commit.js';

/** One `--accept-rewrite <branch>=<old>..<new>`: the rewrite sync may push. */
export interface AcceptedRewrite {
  branch: string;
  /** Full commit id origin's copy of the branch must still be at. */
  from: string;
  /** Full commit id upstream's branch must be at. */
  to: string;
}

/** Where origin's copy of a tracked branch stands against upstream's. */
export type TrackedBranchState =
  | 'up-to-date'
  | 'missing'
  | 'behind'
  | 'diverged'
  | 'no-upstream';

/** A tracked branch as read from the fetched refs. Nothing is pushed. */
export interface TrackedBranchPlan {
  branch: TrackedBranch;
  state: TrackedBranchState;
  /** Commit id of `refs/remotes/upstream/<name>`, or '' when upstream has none. */
  upstreamTip: string;
  /** Commit id of `refs/remotes/origin/<name>`, or '' when origin has none. */
  originTip: string;
}

/** What sync did to one tracked branch, as `--json` reports it. */
export interface TrackedBranchResult {
  name: string;
  /**
   * `diverged` and `no-upstream`: sync left origin's copy as it was and
   * warned; `venfork doctor` fails its `tracked` row until it is resolved.
   */
  status:
    | 'up-to-date'
    | 'created'
    | 'fast-forwarded'
    | 'rewritten'
    | 'diverged'
    | 'no-upstream';
  /** Origin's branch after sync ('' when origin has none). */
  tip: string;
  /** Origin's branch before sync, when sync moved it. */
  previous?: string;
  /** `upstream/<name>`, when sync left origin's copy behind it. */
  upstreamTip?: string;
  /** The `venfork sync --accept-rewrite ...` that replaces a diverged copy, with `allowRewrite: "explicit"`. */
  command?: string;
  /** What to do about a branch sync left as it was. */
  hint?: string;
}

/**
 * Reads where each tracked branch stands, from refs already fetched.
 *
 * @throws ConfigError when a tracked branch is the default branch.
 */
export async function readTrackedBranches(
  tracked: readonly TrackedBranch[],
  defaultBranch: string,
  cwd?: string
): Promise<TrackedBranchPlan[]> {
  const plans: TrackedBranchPlan[] = [];
  for (const branch of tracked) {
    if (branch.name === defaultBranch) {
      throw new ConfigError(
        `Invalid venfork-config config: trackedBranches names '${branch.name}', upstream's default branch, which sync already keeps. Remove it from trackedBranches.`
      );
    }
    const upstreamTip = await resolveCommit(
      `refs/remotes/upstream/${branch.name}`,
      cwd
    );
    const originTip = await resolveCommit(
      `refs/remotes/origin/${branch.name}`,
      cwd
    );
    let state: TrackedBranchState;
    if (!upstreamTip) state = 'no-upstream';
    else if (!originTip) state = 'missing';
    else if (originTip === upstreamTip) state = 'up-to-date';
    else {
      const ancestor = await $({
        ...(cwd ? { cwd } : {}),
        reject: false,
      })`git merge-base --is-ancestor ${originTip} ${upstreamTip}`;
      state = ancestor.exitCode === 0 ? 'behind' : 'diverged';
    }
    plans.push({ branch, state, upstreamTip, originTip });
  }
  return plans;
}

/** `path` to `<mode> <oid>` at `ref`, for the paths `paths` select. */
async function entriesAt(
  ref: string,
  paths: readonly string[],
  cwd?: string
): Promise<Map<string, string>> {
  const result = await $({
    ...(cwd ? { cwd } : {}),
  })`git --literal-pathspecs ls-tree -r -z ${ref} -- ${paths}`;
  const entries = new Map<string, string>();
  for (const record of result.stdout.split('\0').filter(Boolean)) {
    const [meta = '', file = ''] = record.split('\t');
    const [mode = '', , oid = ''] = meta.split(' ');
    entries.set(file, `${mode} ${oid}`);
  }
  return entries;
}

/**
 * Mirror-only files on origin's copy of a tracked branch: kept files
 * (`preserve`), the managed sync workflow and anything under `.venfork/`
 * that `origin/<name>` holds with other content than `upstream/<name>`
 * (or that upstream lacks, branch included). Kept files belong on the default branch only;
 * a tracked branch is upstream's branch as it is.
 */
export async function mirrorOnlyFilesOn(
  plan: TrackedBranchPlan,
  preserve: readonly string[],
  workflowPath: string,
  cwd?: string
): Promise<string[]> {
  if (!plan.originTip) return [];
  const paths = [...new Set([...preserve, workflowPath, '.venfork'])];
  const onOrigin = await entriesAt(plan.originTip, paths, cwd);
  const onUpstream = plan.upstreamTip
    ? await entriesAt(plan.upstreamTip, paths, cwd)
    : new Map<string, string>();
  return [...onOrigin]
    .filter(([file, entry]) => onUpstream.get(file) !== entry)
    .map(([file]) => file)
    .sort();
}

/** The `venfork sync --accept-rewrite` value that accepts `plan` as it is now. */
export function acceptRewriteFlag(plan: TrackedBranchPlan): string {
  return `--accept-rewrite ${plan.branch.name}=${plan.originTip}..${plan.upstreamTip}`;
}

/**
 * Checks every `--accept-rewrite` against the tracked branches as read,
 * before anything is pushed: it must name a tracked branch with
 * `allowRewrite: "explicit"` that has diverged, with both tips exactly as
 * sync sees them.
 *
 * @throws PreconditionError for any other `--accept-rewrite`, naming the
 *   command to run instead when there is one.
 */
export function assertRewritesAccepted(
  plans: readonly TrackedBranchPlan[],
  accepted: readonly AcceptedRewrite[]
): void {
  for (const rewrite of accepted) {
    const { branch: name } = rewrite;
    const plan = plans.find((p) => p.branch.name === name);
    if (!plan) {
      throw new PreconditionError(
        `--accept-rewrite names '${name}', which trackedBranches does not list.`
      );
    }
    if (plan.branch.allowRewrite !== 'explicit') {
      throw new PreconditionError(
        `--accept-rewrite ${name}: its trackedBranches entry does not set "allowRewrite": "explicit", so sync never rewrites it.`,
        {
          hint: `If upstream rewrote ${name} and origin/${name} has nothing of its own, set "allowRewrite": "explicit" on the entry and run the sync again.`,
        }
      );
    }
    if (plan.state !== 'diverged') {
      throw new PreconditionError(
        `--accept-rewrite ${name}: origin/${name} has not diverged from upstream/${name} (${plan.state}), so there is no rewrite to accept.`,
        { hint: 'Run `venfork sync` without --accept-rewrite.' }
      );
    }
    if (rewrite.from !== plan.originTip || rewrite.to !== plan.upstreamTip) {
      throw new PreconditionError(
        `--accept-rewrite ${name}=${rewrite.from.slice(0, 12)}..${rewrite.to.slice(0, 12)} does not match origin/${name} at ${plan.originTip.slice(0, 12)} and upstream/${name} at ${plan.upstreamTip.slice(0, 12)}.`,
        {
          hint: `Check what changed, then run \`venfork sync ${acceptRewriteFlag(plan)}\`.`,
        }
      );
    }
  }
}

/** The result for a tracked branch sync leaves as it is, with the next step. */
function leftAsIs(plan: TrackedBranchPlan): TrackedBranchResult {
  const { name } = plan.branch;
  if (plan.state === 'no-upstream') {
    return {
      name,
      status: 'no-upstream',
      tip: plan.originTip,
      hint: `upstream has no branch ${name}. Check the branch on upstream, or remove it from trackedBranches.`,
    };
  }
  const explicit = plan.branch.allowRewrite === 'explicit';
  return {
    name,
    status: 'diverged',
    tip: plan.originTip,
    upstreamTip: plan.upstreamTip,
    ...(explicit ? { command: `venfork sync ${acceptRewriteFlag(plan)}` } : {}),
    hint: explicit
      ? `If upstream rewrote ${name} and origin/${name} has nothing of its own, run \`venfork sync ${acceptRewriteFlag(plan)}\`.`
      : `If upstream rewrote ${name}, set "allowRewrite": "explicit" on its trackedBranches entry and run \`venfork sync ${acceptRewriteFlag(plan)}\`. If origin/${name} has commits of its own, move them to another branch first.`,
  };
}

/** One warning line for a tracked branch sync left as it is. */
export function leftAsIsWarning(result: TrackedBranchResult): string {
  return result.status === 'no-upstream'
    ? `Tracked branch ${result.name} not synced: ${result.hint}`
    : `Tracked branch ${result.name} not synced: origin/${result.name} (${result.tip.slice(0, 12)}) is not an ancestor of upstream/${result.name} (${(result.upstreamTip ?? '').slice(0, 12)}), so a fast-forward is not possible. ${result.hint}`;
}

/**
 * Points origin's copy of each tracked branch at upstream's tip: creates a
 * missing branch, fast-forwards one that is behind and, for a diverged
 * branch whose `--accept-rewrite` {@link assertRewritesAccepted} checked,
 * replaces it. Every push has an explicit lease on the tip that was read.
 * A diverged branch without an accepted rewrite, and one upstream does not
 * have, are left as they are and reported.
 */
export async function pushTrackedBranches(
  plans: readonly TrackedBranchPlan[],
  accepted: readonly AcceptedRewrite[],
  cwd?: string
): Promise<TrackedBranchResult[]> {
  const results: TrackedBranchResult[] = [];
  for (const plan of plans) {
    const { name } = plan.branch;
    if (plan.state === 'up-to-date') {
      results.push({ name, status: 'up-to-date', tip: plan.upstreamTip });
      continue;
    }
    if (
      plan.state === 'no-upstream' ||
      (plan.state === 'diverged' && !accepted.some((r) => r.branch === name))
    ) {
      results.push(leftAsIs(plan));
      continue;
    }
    await pushBranchWithLease({
      remote: 'origin',
      branch: name,
      target: plan.upstreamTip,
      expected: plan.originTip,
      cwd,
    });
    results.push({
      name,
      status:
        plan.state === 'missing'
          ? 'created'
          : plan.state === 'behind'
            ? 'fast-forwarded'
            : 'rewritten',
      tip: plan.upstreamTip,
      ...(plan.originTip ? { previous: plan.originTip } : {}),
    });
  }
  return results;
}

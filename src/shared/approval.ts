import type { ApprovalLevel } from '../config.js';
import { ApprovalError, GitHubError, PreconditionError } from '../errors.js';
import { netExec, netFailureReason } from './net.js';

/** A gate level that needs a review: every level but `off`. */
export type GateLevel = Exclude<ApprovalLevel, 'off'>;

/** The branch's open pull request on the private mirror. */
export interface MirrorPr {
  number: number;
  url: string;
  /** Full SHA of the PR head: the only commit an approval can cover. */
  headSha: string;
  author: string;
}

/** One submitted review, in the order GitHub lists them (oldest first). */
export interface PrReview {
  login: string;
  /** GitHub account type: `User`, `Bot`, `Organization`. */
  type: string;
  state: string;
  commitId: string;
}

/** One check run or commit status on the PR head. */
export interface HeadCheck {
  name: string;
  state: 'pending' | 'passed' | 'failed';
}

/** Everything the gate decides on, read from GitHub. */
export interface ApprovalFacts {
  level: GateLevel;
  branch: string;
  mirror: string;
  pr: MirrorPr;
  /** gh login of the person running stage; empty at `reviewed`, which never reads it. */
  stager: string;
  reviews: PrReview[];
  /** Mirror permission per reviewer login (lower case): `admin`, `write`, `read`, `none`. */
  permissions: Map<string, string>;
  checks: HeadCheck[];
}

/** A met gate: who approved, and the head SHA stage must ship. */
export interface ApprovalPass {
  level: GateLevel;
  /** Number of the approved mirror PR. */
  prNumber: number;
  prUrl: string;
  headSha: string;
  approvers: string[];
}

/**
 * Posts the `--force` record on the mirror PR, and only there: the gh
 * login, the level that was bypassed, the commit staged and why the gate
 * refused. The body travels on stdin.
 * @throws GitHubError when the comment cannot be posted.
 */
export async function recordBypassOnMirrorPr(input: {
  mirror: string;
  prNumber: number;
  prUrl: string;
  login: string;
  level: GateLevel;
  sourceHead: string;
  refusal: string;
  cwd: string;
}): Promise<void> {
  const body = [
    `The venfork approval gate (${input.level}) was bypassed with \`venfork stage --force\` by @${input.login}.`,
    '',
    `Staged commit: ${input.sourceHead}`,
    `Gate refusal: ${input.refusal}`,
  ].join('\n');
  const result = await netExec(input.cwd, {
    bufferOutput: true,
    input: JSON.stringify({ body }),
  })`gh api --method POST repos/${input.mirror}/issues/${String(input.prNumber)}/comments --input -`;
  if (result.exitCode !== 0) {
    throw new GitHubError(
      `Not staged: could not record the --force bypass on ${input.prUrl}: ${netFailureReason(result)}`
    );
  }
}

const PASSING = new Set(['success', 'neutral', 'skipped']);

function isBot(review: Pick<PrReview, 'login' | 'type'>): boolean {
  return review.type === 'Bot' || /\[bot\]$/i.test(review.login);
}

function isPerson(review: Pick<PrReview, 'login' | 'type'>): boolean {
  return review.type === 'User' && !isBot(review);
}

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Each reviewer's latest APPROVED, CHANGES_REQUESTED or DISMISSED review.
 * A dismissed latest review neither approves nor blocks; comment-only
 * reviews never change a reviewer's state. Reviews with no login (a deleted
 * account) are skipped.
 */
export function latestReviews(reviews: PrReview[]): PrReview[] {
  const latest = new Map<string, PrReview>();
  for (const review of reviews) {
    if (!review.login || !REVIEW_STATES.has(review.state)) continue;
    latest.set(review.login.toLowerCase(), review);
  }
  return [...latest.values()];
}

/** Logins whose latest review could approve, before the permission check. */
export function approvalCandidates(
  level: GateLevel,
  pr: MirrorPr,
  stager: string,
  reviews: PrReview[]
): string[] {
  return latestReviews(reviews)
    .filter(
      (r) =>
        r.state === 'APPROVED' &&
        r.commitId === pr.headSha &&
        isPerson(r) &&
        !same(r.login, pr.author) &&
        (level === 'reviewed' || !same(r.login, stager))
    )
    .map((r) => r.login);
}

const SWITCH_TO_REVIEWED =
  'Working alone? `venfork stage approval reviewed` lets the person who approved also stage.';

/**
 * Decides the gate from `facts`: a reviewer's latest CHANGES_REQUESTED
 * blocks, at least one approval must qualify, and every check on the head
 * must be complete and passing.
 * @throws ApprovalError naming what is missing, with a one-line next step.
 */
export function evaluateApproval(facts: ApprovalFacts): ApprovalPass {
  const { level, branch, pr, stager } = facts;
  const base = {
    prNumber: pr.number,
    prUrl: pr.url,
    headSha: pr.headSha,
    level,
  };
  const latest = latestReviews(facts.reviews);
  const blocking = latest.filter(
    (r) => r.state === 'CHANGES_REQUESTED' && !isBot(r)
  );
  if (blocking.length > 0) {
    const who = blocking.map((r) => r.login).join(', ');
    throw new ApprovalError(
      'changes-requested',
      `Not staged: ${who} requested changes on ${pr.url}.`,
      'Address the review and get a new approval on the PR head.',
      { ...base, reviewers: blocking.map((r) => r.login) }
    );
  }
  const approvers = approvalCandidates(level, pr, stager, facts.reviews).filter(
    (login) => {
      const permission = facts.permissions.get(login.toLowerCase());
      return permission === 'admin' || permission === 'write';
    }
  );
  if (approvers.length === 0) {
    const approvedHead = latest.filter(
      (r) => r.state === 'APPROVED' && r.commitId === pr.headSha && isPerson(r)
    );
    if (
      level === 'two-person' &&
      approvedHead.some((r) => same(r.login, stager)) &&
      approvedHead.every(
        (r) => same(r.login, stager) || same(r.login, pr.author)
      )
    ) {
      throw new ApprovalError(
        'self-approved',
        `Not staged: two-person approval needs a reviewer other than you (${stager}) on ${pr.url}.`,
        SWITCH_TO_REVIEWED,
        base
      );
    }
    const stale = latest.some(
      (r) => r.state === 'APPROVED' && r.commitId !== pr.headSha
    );
    throw new ApprovalError(
      'not-approved',
      stale
        ? `Not staged: the approval on ${pr.url} is for an older commit, not the head ${pr.headSha.slice(0, 12)}.`
        : `Not staged: ${pr.url} has no approving review that counts for '${branch}' (${level}).`,
      stale
        ? 'Ask the reviewer to approve the PR again.'
        : `Ask someone with write access to the mirror, other than the PR author${level === 'two-person' ? ' and you' : ''}, to approve it.`,
      base
    );
  }
  const failed = facts.checks.filter((c) => c.state === 'failed');
  if (failed.length > 0) {
    throw new ApprovalError(
      'checks-failed',
      `Not staged: check(s) failed on ${pr.url}: ${failed.map((c) => c.name).join(', ')}.`,
      'Fix the failing checks and get the new head approved.',
      { ...base, checks: failed.map((c) => c.name) }
    );
  }
  const pending = facts.checks.filter((c) => c.state === 'pending');
  if (pending.length > 0) {
    throw new ApprovalError(
      'checks-pending',
      `Not staged: check(s) still running on ${pr.url}: ${pending.map((c) => c.name).join(', ')}.`,
      'Wait for the checks to finish, then stage again.',
      { ...base, checks: pending.map((c) => c.name) }
    );
  }
  return { ...base, approvers };
}

async function ghApi(
  cwd: string,
  args: string[],
  what: string
): Promise<string> {
  const result = await netExec(cwd, { bufferOutput: true })`gh api ${args}`;
  if (result.exitCode !== 0) {
    throw new GitHubError(`Cannot read ${what}: ${netFailureReason(result)}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

function parseLines(text: string, what: string): unknown[] {
  try {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new GitHubError(`Cannot read ${what}: gh printed invalid JSON`);
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubError(`Cannot read ${what}: gh printed invalid JSON`);
  }
}

function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function text(value: unknown, ...keys: string[]): string {
  const found = field(value, ...keys);
  return typeof found === 'string' ? found : '';
}

function toMirrorPr(raw: unknown, what: string): MirrorPr {
  const number = field(raw, 'number');
  const headSha = text(raw, 'head', 'sha');
  if (typeof number !== 'number' || !/^[0-9a-f]{40,64}$/.test(headSha)) {
    throw new GitHubError(
      `Cannot read ${what}: gh printed no PR number or head`
    );
  }
  return {
    number,
    url: text(raw, 'html_url'),
    headSha,
    author: text(raw, 'user', 'login'),
  };
}

function prNumberOf(raw: unknown): string {
  return `#${String(field(raw, 'number'))}`;
}

function headRepoOf(raw: unknown): string {
  return text(raw, 'head', 'repo', 'full_name');
}

function defaultBranchOf(raw: unknown, what: string): string {
  const branch = text(raw, 'base', 'repo', 'default_branch');
  if (!branch) {
    throw new GitHubError(
      `Cannot read ${what}: gh printed no mirror default branch`
    );
  }
  return branch;
}

/** Which PR the gate looks for: `branch` on `mirror`, at `level`. */
export interface PrTarget {
  level: GateLevel;
  mirror: string;
  branch: string;
}

function wrongBase(
  raw: unknown,
  target: PrTarget,
  what: string
): ApprovalError {
  const { level, mirror } = target;
  const defaultBranch = defaultBranchOf(raw, what);
  const baseRef = text(raw, 'base', 'ref');
  return new ApprovalError(
    'wrong-base',
    `Not staged: PR ${prNumberOf(raw)} on ${mirror} targets '${baseRef}', not the mirror default branch '${defaultBranch}'.`,
    `Retarget the PR to '${defaultBranch}' and get it approved there, so the review covers every commit stage ships.`,
    { level, prUrl: text(raw, 'html_url'), base: baseRef, defaultBranch }
  );
}

/**
 * Picks the mirror PR the gate reads from the open PRs listed for `branch`:
 * a PR whose head is `branch` on the mirror and whose base is the mirror
 * default branch. Returns null when no PR has that head.
 * @throws ApprovalError `wrong-base` when every such PR targets another
 *   branch, or `ambiguous-pr` when more than one targets the default branch.
 */
export function selectMirrorPr(
  listed: unknown[],
  target: PrTarget
): MirrorPr | null {
  const { level, mirror, branch } = target;
  const what = `the mirror PRs for '${branch}'`;
  const heads = listed.filter(
    (raw) =>
      text(raw, 'head', 'ref') === branch && same(headRepoOf(raw), mirror)
  );
  const [first] = heads;
  if (first === undefined) return null;
  const onDefault = heads.filter(
    (raw) => text(raw, 'base', 'ref') === defaultBranchOf(raw, what)
  );
  if (onDefault.length === 0) throw wrongBase(first, target, what);
  if (onDefault.length > 1) {
    const numbers = onDefault
      .map((raw) => field(raw, 'number'))
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b);
    throw new ApprovalError(
      'ambiguous-pr',
      `Not staged: '${branch}' has ${numbers.length} open PRs on ${mirror} into '${defaultBranchOf(first, what)}': ${numbers.map((n) => `#${n}`).join(', ')}.`,
      'Pass --internal-pr <n> to name the PR whose approval counts, or close the others.',
      { level, branch, mirror, prNumbers: numbers }
    );
  }
  return toMirrorPr(onDefault[0], what);
}

/**
 * Checks that PR `pinned`, named with `--internal-pr`, is an open PR from
 * `branch` on the mirror into the mirror default branch.
 * @throws ApprovalError naming what does not match.
 */
export function checkPinnedPr(
  raw: unknown,
  target: PrTarget,
  pinned: number
): MirrorPr {
  const { level, mirror, branch } = target;
  const what = `PR #${pinned}`;
  const name = `PR #${pinned} on ${mirror}`;
  const details = { level, prUrl: text(raw, 'html_url'), branch, mirror };
  if (text(raw, 'state') !== 'open') {
    throw new ApprovalError(
      'no-mirror-pr',
      `Not staged: ${name} is not open.`,
      `Reopen it, or pass the number of the open PR for '${branch}'.`,
      details
    );
  }
  const headRepo = headRepoOf(raw);
  if (!same(headRepo, mirror)) {
    throw new ApprovalError(
      'wrong-head',
      `Not staged: ${name} is not from the mirror: its head is in ${headRepo || 'a deleted repository'}.`,
      `Open the PR from '${branch}' on ${mirror}.`,
      { ...details, headRepo }
    );
  }
  const headRef = text(raw, 'head', 'ref');
  if (headRef !== branch) {
    throw new ApprovalError(
      'wrong-head',
      `Not staged: ${name} is for '${headRef}', not '${branch}'.`,
      `Pass the number of the open PR for '${branch}', or stage '${headRef}'.`,
      { ...details, headRef }
    );
  }
  if (text(raw, 'base', 'ref') !== defaultBranchOf(raw, what)) {
    throw wrongBase(raw, target, what);
  }
  return toMirrorPr(raw, what);
}

/**
 * The open PR on `mirror` from `branch` into the mirror default branch, or
 * PR `pinned` when `--internal-pr` names it. Null when the branch has no
 * open PR.
 * @throws ApprovalError when the PR found cannot be the one the gate reads.
 */
export async function findOpenMirrorPr(
  target: PrTarget,
  cwd: string,
  pinned?: number
): Promise<MirrorPr | null> {
  const { mirror, branch } = target;
  if (pinned !== undefined) {
    const raw = parseJson(
      await ghApi(cwd, [`repos/${mirror}/pulls/${pinned}`], `PR #${pinned}`),
      `PR #${pinned}`
    );
    return checkPinnedPr(raw, target, pinned);
  }
  const owner = mirror.split('/')[0] ?? '';
  const query = `head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&sort=created&direction=desc&per_page=100`;
  const list = parseJson(
    await ghApi(
      cwd,
      [`repos/${mirror}/pulls?${query}`],
      `the mirror PRs for '${branch}'`
    ),
    `the mirror PRs for '${branch}'`
  );
  return selectMirrorPr(Array.isArray(list) ? list : [], target);
}

function checkRunState(run: unknown): HeadCheck['state'] {
  if (text(run, 'status') !== 'completed') return 'pending';
  return PASSING.has(text(run, 'conclusion')) ? 'passed' : 'failed';
}

function statusState(status: unknown): HeadCheck['state'] {
  const state = text(status, 'state');
  if (state === 'success') return 'passed';
  if (state === 'pending') return 'pending';
  return 'failed';
}

/** Every check run and the latest commit status per context on `sha`. */
async function readHeadChecks(
  mirror: string,
  sha: string,
  cwd: string
): Promise<HeadCheck[]> {
  const runs = parseLines(
    await ghApi(
      cwd,
      [
        '--paginate',
        `repos/${mirror}/commits/${sha}/check-runs?per_page=100`,
        '--jq',
        '.check_runs[] | tojson',
      ],
      'the PR head check runs'
    ),
    'the PR head check runs'
  );
  const statuses = parseLines(
    await ghApi(
      cwd,
      [
        '--paginate',
        `repos/${mirror}/commits/${sha}/status?per_page=100`,
        '--jq',
        '.statuses[] | tojson',
      ],
      'the PR head commit statuses'
    ),
    'the PR head commit statuses'
  );
  return [
    ...runs.map((run) => ({
      name: text(run, 'name') || 'check run',
      state: checkRunState(run),
    })),
    ...statuses.map((status) => ({
      name: text(status, 'context') || 'status',
      state: statusState(status),
    })),
  ];
}

/** The gh login running this command. */
export async function ghLogin(cwd: string): Promise<string> {
  const login = text(
    parseJson(await ghApi(cwd, ['user'], 'your gh login'), 'your gh login'),
    'login'
  );
  if (!login)
    throw new GitHubError('Cannot read your gh login: gh printed no login');
  return login;
}

/** Everything {@link evaluateApproval} needs, read through gh. */
export async function readApprovalFacts(input: {
  level: GateLevel;
  mirror: string;
  branch: string;
  cwd: string;
  pinnedPr?: number;
}): Promise<ApprovalFacts> {
  const { level, mirror, branch, cwd } = input;
  const pr = await findOpenMirrorPr(
    { level, mirror, branch },
    cwd,
    input.pinnedPr
  );
  if (!pr) {
    throw new ApprovalError(
      'no-mirror-pr',
      `Not staged: approval is ${level} and '${branch}' has no open PR on ${mirror}.`,
      `Push the branch, open a PR for it on ${mirror} and get it approved. Working alone? \`venfork stage approval reviewed\` lets the person who approves also stage.`,
      { level, branch, mirror }
    );
  }
  const stager = level === 'two-person' ? await ghLogin(cwd) : '';
  const reviews = parseLines(
    await ghApi(
      cwd,
      [
        '--paginate',
        `repos/${mirror}/pulls/${pr.number}/reviews?per_page=100`,
        '--jq',
        '.[] | tojson',
      ],
      `the reviews on ${pr.url}`
    ),
    `the reviews on ${pr.url}`
  ).map((raw) => ({
    login: text(raw, 'user', 'login'),
    type: text(raw, 'user', 'type'),
    state: text(raw, 'state'),
    commitId: text(raw, 'commit_id'),
  }));
  const permissions = new Map<string, string>();
  for (const login of approvalCandidates(level, pr, stager, reviews)) {
    const raw = parseJson(
      await ghApi(
        cwd,
        [
          `repos/${mirror}/collaborators/${encodeURIComponent(login)}/permission`,
        ],
        `${login}'s permission on ${mirror}`
      ),
      `${login}'s permission on ${mirror}`
    );
    permissions.set(login.toLowerCase(), text(raw, 'permission'));
  }
  const checks = await readHeadChecks(mirror, pr.headSha, cwd);
  return { level, branch, mirror, pr, stager, reviews, permissions, checks };
}

/**
 * Checks the mirror's approval gate for `branch` and returns the approved
 * PR head that stage must ship.
 * @throws PreconditionError when origin is not a GitHub repository.
 * @throws ApprovalError when the level is not met.
 */
export async function checkApprovalGate(input: {
  level: GateLevel;
  mirror: string | null;
  branch: string;
  cwd: string;
  pinnedPr?: number;
}): Promise<ApprovalPass> {
  if (!input.mirror) {
    throw new PreconditionError(
      `Not staged: approval is ${input.level}, and origin is not a GitHub repository, so venfork cannot read the mirror PR.`,
      {
        hint: 'Run `venfork stage approval off` on a mirror that is not on GitHub.',
      }
    );
  }
  return evaluateApproval(
    await readApprovalFacts({ ...input, mirror: input.mirror })
  );
}

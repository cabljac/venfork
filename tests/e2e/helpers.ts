import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'execa';

/**
 * Owner of the synthetic "upstream" repo created during the e2e run.
 * Defaults to the user account `cabljac`. GitHub disallows a single account
 * owning both a parent and a fork, so this MUST differ from `GITHUB_ORG`.
 */
export const UPSTREAM_OWNER =
  process.env.VENFORK_E2E_UPSTREAM_OWNER ?? 'cabljac';

/**
 * Owner of the mirror + public fork repos created during the e2e run.
 * Defaults to the `memcard-dev` org. Override with `VENFORK_E2E_ORG`.
 */
export const GITHUB_ORG = process.env.VENFORK_E2E_ORG ?? 'memcard-dev';

const TEST_PREFIX = 'venfork-e2e';
export const RUN_ID = randomBytes(4).toString('hex');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const VENFORK_BIN = path.join(REPO_ROOT, 'dist', 'index.js');

export const names = {
  upstream: `${TEST_PREFIX}-src-${RUN_ID}`,
  mirrorBare: `${TEST_PREFIX}-${RUN_ID}-private`,
  fork: `${TEST_PREFIX}-${RUN_ID}-fork`,
};

export const tmpRoot = path.join(REPO_ROOT, 'tmp', `${TEST_PREFIX}-${RUN_ID}`);
export const localMirrorPath = path.join(tmpRoot, names.mirrorBare);

const ghQuiet = $({ reject: false });

/**
 * Verifies `gh` is authenticated. Throws an actionable error otherwise.
 */
export async function ensureGhAuth(): Promise<void> {
  const result = await ghQuiet`gh auth status`;
  if (result.exitCode !== 0) {
    throw new Error(
      'gh CLI is not authenticated. Run `gh auth login` (or set GH_TOKEN) before running e2e.'
    );
  }
}

/**
 * Warns (does not fail) if the gh token lacks the `delete_repo` scope.
 * Cleanup will leak repos in that case.
 */
export async function ensureDeleteRepoScope(): Promise<void> {
  const result = await ghQuiet`gh auth status`;
  const haystack = `${result.stdout}\n${result.stderr}`;
  if (!/delete_repo/.test(haystack)) {
    console.warn(
      '[venfork-e2e] WARNING: `delete_repo` scope not detected on gh auth.'
    );
    console.warn(
      '[venfork-e2e] Cleanup will leak repos. Fix with: gh auth refresh -s delete_repo'
    );
  }
}

/**
 * Throws if the upstream and mirror/fork would land under the same owner —
 * GitHub rejects same-owner forks ("A single user account cannot own both a
 * parent and fork").
 */
export function ensureDistinctOwners(): void {
  if (UPSTREAM_OWNER === GITHUB_ORG) {
    throw new Error(
      `VENFORK_E2E_UPSTREAM_OWNER (${UPSTREAM_OWNER}) must differ from VENFORK_E2E_ORG (${GITHUB_ORG}). ` +
        'GitHub rejects forks where the parent and fork share the same owner.'
    );
  }
}

/**
 * Creates the upstream repo under `UPSTREAM_OWNER` with an initial README so
 * it can be forked.
 */
export async function createUpstreamRepo(): Promise<void> {
  await $`gh repo create ${UPSTREAM_OWNER}/${names.upstream} --public --add-readme`;
}

/**
 * Pushes a new commit to the upstream repo via the GitHub contents API.
 * Creates the file if missing, updates it (with required sha) if present.
 */
export async function pokeUpstream(
  filename: string,
  content: string
): Promise<void> {
  const apiPath = `repos/${UPSTREAM_OWNER}/${names.upstream}/contents/${filename}`;
  const b64 = Buffer.from(content, 'utf8').toString('base64');

  const existing = await ghQuiet`gh api ${apiPath} --jq .sha`;
  const message = `e2e poke ${filename}`;

  if (existing.exitCode === 0 && existing.stdout.trim()) {
    const sha = existing.stdout.trim();
    await $`gh api ${apiPath} -X PUT -f message=${message} -f content=${b64} -f sha=${sha}`;
  } else {
    await $`gh api ${apiPath} -X PUT -f message=${message} -f content=${b64}`;
  }
}

/**
 * Returns the SHA at the tip of `branch` for `<owner>/<repo>`.
 */
export async function getDefaultBranchSha(
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  const { stdout } =
    await $`gh api repos/${owner}/${repo}/branches/${branch} --jq .commit.sha`;
  return stdout.trim();
}

/**
 * Returns the actual default branch name (`main`/`master`) of `<owner>/<repo>`.
 */
export async function getRepoDefaultBranch(
  owner: string,
  repo: string
): Promise<string> {
  const { stdout } =
    await $`gh api repos/${owner}/${repo} --jq .default_branch`;
  return stdout.trim();
}

/**
 * Returns up to `limit` recent commit messages on `branch`.
 */
export async function listCommitMessages(
  owner: string,
  repo: string,
  branch: string,
  limit: number
): Promise<string[]> {
  const apiPath = `repos/${owner}/${repo}/commits?sha=${branch}&per_page=${limit}`;
  const { stdout } = await $`gh api ${apiPath} --jq .[].commit.message`;
  return stdout.split('\n').filter((line) => line.length > 0);
}

/**
 * Reads `.github/workflows/venfork-sync.yml` from the tip of `origin/<branch>`
 * in the local mirror clone.
 */
export async function readWorkflowFromOrigin(
  repoDir: string,
  branch: string
): Promise<string> {
  await $({ cwd: repoDir })`git fetch origin ${branch}`;
  const ref = `origin/${branch}:.github/workflows/venfork-sync.yml`;
  const { stdout } = await $({ cwd: repoDir })`git show ${ref}`;
  return stdout;
}

/**
 * Spawns the built venfork CLI with the given args and cwd.
 *
 * stdout/stderr are inherited for visibility. stdin is piped — when `input` is
 * provided it's written verbatim, then the pipe closes. This lets us answer
 * known-up-front interactive prompts (e.g. the "Continue with personal
 * account?" confirm in `venfork setup` when `--org` matches the gh user).
 */
export async function runVenfork(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; input?: string }
): Promise<void> {
  await $({
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['pipe', 'inherit', 'inherit'],
    input: opts.input ?? '',
  })`node ${VENFORK_BIN} ${args}`;
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function deleteRepo(owner: string, name: string): Promise<void> {
  await ghQuiet`gh repo delete ${owner}/${name} --yes`;
}

/**
 * Returns the OAuth token currently used by `gh` (or `VENFORK_E2E_PAT` if set).
 * Used by Tier 2 to authenticate cross-repo pushes inside the GHA runner.
 */
export async function getPushToken(): Promise<string> {
  if (process.env.VENFORK_E2E_PAT) {
    return process.env.VENFORK_E2E_PAT;
  }
  const { stdout } = await $`gh auth token`;
  const token = stdout.trim();
  if (!token) {
    throw new Error(
      'Could not resolve a push token: `gh auth token` returned empty and VENFORK_E2E_PAT is not set'
    );
  }
  return token;
}

/**
 * Stores `value` as a repo secret named `name` on `<owner>/<repo>`.
 * The secret is removed automatically when the repo is deleted in `afterAll`.
 *
 * NOTE: `gh secret set` reads stdin only when `--body` is *omitted*. Passing
 * `--body -` would literally set the secret to "-".
 */
export async function setRepoSecret(
  owner: string,
  repo: string,
  name: string,
  value: string
): Promise<void> {
  await $({
    input: value,
  })`gh secret set ${name} --repo ${owner}/${repo}`;
}

interface WorkflowRun {
  databaseId: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  event: string;
  url?: string;
}

/**
 * Polls `gh run list` for a new workflow_dispatch run on the given workflow
 * created at or after `dispatchedAt`. Returns the matching run id.
 */
export async function waitForDispatchedRun(
  owner: string,
  repo: string,
  workflowFilename: string,
  dispatchedAt: Date,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const dispatchedAtMs = dispatchedAt.getTime();
  while (Date.now() < deadline) {
    const { stdout } =
      await $`gh run list --workflow=${workflowFilename} --repo ${owner}/${repo} --limit 5 --json databaseId,createdAt,event,status,conclusion`;
    const runs: WorkflowRun[] = JSON.parse(stdout);
    const match = runs.find(
      (r) =>
        r.event === 'workflow_dispatch' &&
        new Date(r.createdAt).getTime() >= dispatchedAtMs - 5_000
    );
    if (match) {
      return match.databaseId;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(
    `No workflow_dispatch run for ${workflowFilename} appeared within ${timeoutMs}ms`
  );
}

/**
 * Polls `gh run view` until status=completed or timeout. Returns the final
 * conclusion (e.g. `success`, `failure`, `cancelled`).
 */
export async function waitForRunCompletion(
  owner: string,
  repo: string,
  runId: number,
  timeoutMs: number
): Promise<{ conclusion: string; url?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } =
      await $`gh run view ${runId} --repo ${owner}/${repo} --json status,conclusion,url`;
    const run: WorkflowRun = JSON.parse(stdout);
    if (run.status === 'completed') {
      return { conclusion: run.conclusion ?? 'unknown', url: run.url };
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Workflow run ${runId} did not complete in ${timeoutMs}ms`);
}

export async function cleanupAll(): Promise<void> {
  await Promise.allSettled([
    deleteRepo(UPSTREAM_OWNER, names.upstream),
    deleteRepo(GITHUB_ORG, names.fork),
    deleteRepo(GITHUB_ORG, names.mirrorBare),
  ]);
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

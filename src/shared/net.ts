import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { $ } from 'execa';
import { GitError } from '../errors.js';
import { gitNetTimeoutMs, NET_ENV, NET_SSH_OPTIONS } from './constants.js';

function configuredSshCommand(cwd?: string): string | undefined {
  const fromEnv = process.env.GIT_SSH_COMMAND?.trim();
  if (fromEnv) return fromEnv;
  const result = spawnSync('git', ['config', '--get', 'core.sshCommand'], {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const fromConfig = result.status === 0 ? result.stdout.trim() : '';
  return fromConfig || undefined;
}

/**
 * The `GIT_SSH_COMMAND` for a network op run in `cwd`: the user's own ssh
 * command (env, else `core.sshCommand`) with the fail-fast options appended,
 * or plain `ssh` with them.
 */
export function netSshCommand(cwd?: string): string {
  return `${configuredSshCommand(cwd) ?? 'ssh'} ${NET_SSH_OPTIONS}`;
}

/**
 * An execa `$` bound for a heavy network git/gh op: no stdin (any
 * credential/host-key prompt fails fast instead of hanging on an invisible
 * prompt), a hard timeout, and live progress on stderr.
 *
 * @param cwd Working directory for the command, or undefined for the default.
 * @param opts.captureOutput Pipe stdout/stderr unbuffered so the caller can
 *   stream them (seed pushes).
 * @param opts.bufferOutput Pipe and buffer stdout/stderr and never reject, so
 *   the caller can read `exitCode`, `stdout`, `stderr` and `timedOut`.
 * @param opts.input Fixed stdin content; stdin closes after it, so a prompt
 *   still cannot wait for the user.
 */
export function netExec(
  cwd?: string,
  opts?: { captureOutput?: boolean; bufferOutput?: boolean; input?: string }
) {
  const captureOutput = opts?.captureOutput === true;
  const bufferOutput = opts?.bufferOutput === true;
  const stdin = opts?.input === undefined ? 'ignore' : 'pipe';
  return $({
    ...(cwd ? { cwd } : {}),
    ...(opts?.input === undefined ? {} : { input: opts.input }),
    env: { ...NET_ENV, GIT_SSH_COMMAND: netSshCommand(cwd) },
    timeout: gitNetTimeoutMs(),
    stdio:
      captureOutput || bufferOutput
        ? [stdin, 'pipe', 'pipe']
        : [stdin, 'inherit', 'inherit'],
    ...(captureOutput ? { buffer: false } : {}),
    ...(bufferOutput ? { reject: false } : {}),
  });
}

/**
 * One-line reason a {@link netExec} `bufferOutput` call failed: the timeout,
 * else stderr, else the exit code.
 */
export function netFailureReason(result: {
  timedOut?: boolean;
  stderr?: unknown;
  exitCode?: number;
}): string {
  if (result.timedOut) {
    return `timed out after ${gitNetTimeoutMs() / 1000}s`;
  }
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  return stderr || `exit ${result.exitCode ?? 'unknown'}`;
}

/**
 * Runs `git fetch <remote>` through {@link netExec}; throws a `GitError`
 * with git's reason when it fails or times out.
 */
export async function netFetch(remote: string, cwd?: string): Promise<void> {
  const result = await netExec(cwd, {
    bufferOutput: true,
  })`git fetch ${remote}`;
  if (result.exitCode !== 0) {
    throw new GitError(
      `git fetch ${remote} failed: ${netFailureReason(result)}`,
      `git fetch ${remote}`
    );
  }
}

/**
 * Run a long-running network operation (built with {@link netExec}) with a
 * start/stop message and a clear, fast failure when it times out.
 *
 * @param startMsg Message shown before the op starts.
 * @param stopMsg Message shown when the op completes.
 * @param op Performs the command, returning the execa promise.
 */
export async function runNetOp(
  startMsg: string,
  stopMsg: string,
  op: () => Promise<unknown>
): Promise<void> {
  p.log.info(`${startMsg}…`);
  try {
    await op();
  } catch (err) {
    if ((err as { timedOut?: boolean })?.timedOut) {
      throw new GitError(
        `${startMsg} timed out after ${gitNetTimeoutMs() / 1000}s. ` +
          'Check network and GitHub auth, or raise VENFORK_GIT_TIMEOUT.',
        startMsg
      );
    }
    throw err;
  }
  p.log.success(stopMsg);
}

/** `-c` flags that make a large seed push survive: gh credentials over
 *  HTTPS, a big post buffer + HTTP/1.1 (avoids chunked-encoding issues on
 *  big POSTs), and a stalled-transfer abort. */
const SEED_PUSH_CONFIG = [
  '-c',
  'credential.https://github.com.helper=!gh auth git-credential',
  '-c',
  'http.postBuffer=524288000',
  '-c',
  'http.version=HTTP/1.1',
  '-c',
  'http.lowSpeedLimit=1000',
  '-c',
  'http.lowSpeedTime=60',
];

/**
 * Whether a failed seed push is worth retrying. Retry only recognized
 * server-side/transport failures during a large transfer (timeouts,
 * gateways, dropped connections). Auth/permission/not-found/protected-branch
 * and any unrecognized failure fail fast — retrying those just delays a
 * permanent setup error.
 */
export function isTransientPushError(err: unknown): boolean {
  if (err instanceof GitError) return false; // hard timeout
  const e = err as {
    stderr?: unknown;
    stdout?: unknown;
    shortMessage?: unknown;
    message?: unknown;
  };
  const text = [e.stderr, e.stdout, e.shortMessage, e.message]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join('\n')
    .toLowerCase();
  if (!text) return false;

  const permanent = [
    'http 401',
    'http 403',
    'http 404',
    'authentication failed',
    'permission denied',
    'access denied',
    'repository not found',
    'could not read from remote repository',
    'protected branch',
    'pre-receive hook declined',
    'remote rejected',
    'remote: error: gh',
  ];
  if (permanent.some((p) => text.includes(p))) return false;

  const transient = [
    'http 408',
    'error: 408',
    'http 500',
    'http 502',
    'http 503',
    'http 504',
    'bad gateway',
    'gateway time',
    'service unavailable',
    'the remote end hung up',
    'unexpected disconnect',
    'early eof',
    'connection reset',
    'connection timed out',
    'operation timed out',
    'failed to connect',
    'recv failure',
    'transfer closed',
  ];
  return transient.some((p) => text.includes(p));
}

const PUSH_OUTPUT_TAIL_CHARS = 16_384;

function appendTail(text: string, chunk: string): string {
  const next = text + chunk;
  return next.length > PUSH_OUTPUT_TAIL_CHARS
    ? next.slice(-PUSH_OUTPUT_TAIL_CHARS)
    : next;
}

async function pushSeedRef(
  tempDir: string,
  httpsUrl: string,
  src: string,
  branch: string
): Promise<void> {
  const push = netExec(tempDir, {
    captureOutput: true,
  })`git ${SEED_PUSH_CONFIG} push --force --no-thin --no-follow-tags --progress ${httpsUrl} ${src}:refs/heads/${branch}`;
  let stdoutTail = '';
  let stderrTail = '';
  push.stdout?.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    process.stdout.write(text);
    stdoutTail = appendTail(stdoutTail, text);
  });
  push.stderr?.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    process.stderr.write(text);
    stderrTail = appendTail(stderrTail, text);
  });

  try {
    await push;
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    if (
      (typeof e.stdout !== 'string' || e.stdout.length === 0) &&
      stdoutTail.length > 0
    ) {
      e.stdout = stdoutTail;
    }
    if (
      (typeof e.stderr !== 'string' || e.stderr.length === 0) &&
      stderrTail.length > 0
    ) {
      e.stderr = stderrTail;
    }
    throw err;
  }
}

/**
 * Seed a fresh private mirror from a local upstream clone.
 *
 * A single `git push` of a large repo's full history 408s — GitHub enforces
 * a request-duration limit and the monolithic pack POST exceeds it. So push
 * the default branch in commit batches (each POST stays small), then push the
 * real tip. History/SHAs are identical to upstream, which `sync`/`stage`/PRs
 * require. Each push is retried a few times to ride out transient 408s.
 *
 * Batch size is `VENFORK_SEED_CHUNK` commits (default 1000); small repos take
 * a single push (loop body is skipped).
 *
 * @param tempDir Local upstream clone.
 * @param httpsUrl HTTPS URL of the private mirror.
 * @param branch Default branch to seed.
 */
export async function seedMirrorInChunks(
  tempDir: string,
  httpsUrl: string,
  branch: string
): Promise<void> {
  const rawChunk = Number(process.env.VENFORK_SEED_CHUNK ?? 1000);
  // Fall back to the default chunk size for invalid values: 0/negative
  // (would infinite-loop) or NaN (non-numeric env).
  const chunk = Number.isInteger(rawChunk) && rawChunk > 0 ? rawChunk : 1000;

  // Select chunk tips along the branch's first-parent ancestry so each pushed
  // tip is guaranteed to descend from the previous one.
  const revList = await $({
    cwd: tempDir,
  })`git rev-list --first-parent --reverse ${branch}`;
  const commits = revList.stdout.split('\n').filter(Boolean);
  const total = commits.length;

  // Treat unset or empty/whitespace-only env as "use default" so an empty
  // string doesn't coerce to 0 (Number('') === 0) and silently disable
  // backoff. An explicit '0' stays valid (0ms backoff).
  const rawRetryMs = process.env.VENFORK_SEED_RETRY_MS;
  const rawBackoff =
    rawRetryMs != null && rawRetryMs.trim() !== '' ? Number(rawRetryMs) : 8000;
  // Fall back to the default for invalid values (negative or NaN).
  const backoffMs =
    Number.isFinite(rawBackoff) && rawBackoff >= 0 ? rawBackoff : 8000;

  const pushRef = async (src: string, label: string): Promise<void> => {
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await runNetOp(
          `Pushing ${label} to private mirror repository` +
            (attempt > 1 ? ` (attempt ${attempt})` : ''),
          `Pushed ${label}`,
          () => pushSeedRef(tempDir, httpsUrl, src, branch)
        );
        return;
      } catch (err) {
        // Fail fast on the last attempt, hard timeouts, and permanent
        // errors (bad creds, missing access, protected branch, …); only
        // recognized transient failures (e.g. HTTP 408) are retried.
        if (attempt === attempts || !isTransientPushError(err)) throw err;
        p.log.warn(
          `Push of ${label} failed; retrying ` + `(${attempt}/${attempts - 1})`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  };

  for (let i = chunk; i < total; i += chunk) {
    await pushRef(commits[i - 1], `commits 1–${i}/${total}`);
  }
  await pushRef(branch, `${branch} (final)`);
}

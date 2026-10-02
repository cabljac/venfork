import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { createConfigBranch } from '../../src/config.js';
import { isolateGitEnv } from './env.js';

/** Which remotes the fixture wires up, matching venfork's `mode`. */
export type FixtureMode = 'standard' | 'no-public';

/** Content of one fixture file; the object form sets the executable bit. */
export type FileSpec = string | { content: string; executable: true };

/** Files to write in one commit, keyed by repo-relative path. */
export type FileMap = Record<string, FileSpec>;

/** Options for {@link createMirrorFixture}. */
export interface MirrorFixtureOptions {
  mode?: FixtureMode;
  /** Number of commits to seed upstream with before the mirror is created. */
  upstreamCommits?: number;
  /** Upstream default branch name. Defaults to `main`. */
  defaultBranch?: string;
}

/**
 * A venfork layout built from local bare repositories: `upstream.git`,
 * `origin.git` (the private mirror) and, in standard mode, `public.git`.
 * `work` is a clone of origin with remotes wired the way `venfork setup`
 * does it, so commands can run against it with no network access.
 */
export interface MirrorFixture {
  root: string;
  mode: FixtureMode;
  defaultBranch: string;
  upstream: string;
  origin: string;
  /** Path to `public.git`, or null in no-public mode. */
  publicFork: string | null;
  /** Developer clone of the mirror; run commands with this as cwd. */
  work: string;
  /** Commits `files` on upstream's default branch and returns the new SHA. */
  commitOnUpstream(files: FileMap, message?: string): Promise<string>;
  /** Commits `files` straight onto origin's default branch, as a teammate would. */
  commitOnOrigin(files: FileMap, message?: string): Promise<string>;
  /** Resolves `ref` in a repo (bare or not) to a full SHA. */
  sha(repo: string, ref: string): Promise<string>;
  /** Commit subjects reachable from `ref`, newest first. */
  subjects(repo: string, ref: string, range?: string): Promise<string[]>;
  /** Number of reflog entries for `ref` in a bare repo (one per accepted push). */
  pushCount(repo: string, ref: string): Promise<number>;
  /** Content of `filePath` at `ref`, or null when the path does not exist. */
  fileAt(repo: string, ref: string, filePath: string): Promise<string | null>;
  /** Tree entry mode of `filePath` at `ref` (e.g. `100755`), or null. */
  modeAt(repo: string, ref: string, filePath: string): Promise<string | null>;
  /** Runs git in `cwd` and returns trimmed stdout. */
  git(cwd: string, ...args: string[]): Promise<string>;
  /** Restores process env and deletes every fixture directory. */
  cleanup(): Promise<void>;
}

const FIXTURE_EPOCH = 1_700_000_000;

/**
 * Builds a fresh {@link MirrorFixture} in a temp directory.
 *
 * Git is isolated from the developer's environment: every `GIT_*`
 * variable, HOME, XDG_CONFIG_HOME and the GitHub tokens are hidden (see
 * {@link isolateGitEnv}), `GIT_CONFIG_GLOBAL` points at a fixture config
 * and `HOME` at an empty fixture directory. Call `cleanup()` to restore
 * them; nested fixtures must be cleaned up in reverse order. Fixture
 * commits use pinned, increasing dates so their SHAs are reproducible. The
 * commands under test run with the real clock unless a test pins
 * `GIT_COMMITTER_DATE` itself.
 */
export async function createMirrorFixture(
  options: MirrorFixtureOptions = {}
): Promise<MirrorFixture> {
  const mode = options.mode ?? 'standard';
  const defaultBranch = options.defaultBranch ?? 'main';
  const root = await mkdtemp(path.join(os.tmpdir(), 'venfork-fixture-'));
  const globalConfig = path.join(root, 'gitconfig');
  const home = path.join(root, 'home');
  await writeFile(
    globalConfig,
    [
      '[user]',
      '\tname = Venfork Test',
      '\temail = test@venfork.invalid',
      '[init]',
      `\tdefaultBranch = ${defaultBranch}`,
      '[commit]',
      '\tgpgsign = false',
      '[advice]',
      '\tdetachedHead = false',
      '',
    ].join('\n')
  );
  await mkdir(home);
  const restoreEnv = isolateGitEnv({
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  });

  try {
    let tick = 0;
    const pinnedEnv = (): Record<string, string> => {
      tick += 1;
      const date = `@${FIXTURE_EPOCH + tick * 60} +0000`;
      return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    };

    const git = async (cwd: string, ...args: string[]): Promise<string> => {
      const result = await $({ cwd })`git ${args}`;
      return result.stdout.trim();
    };

    const commitFiles = async (
      cwd: string,
      files: FileMap,
      message: string
    ): Promise<string> => {
      for (const [filePath, spec] of Object.entries(files)) {
        const full = path.join(cwd, filePath);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, typeof spec === 'string' ? spec : spec.content);
        await git(cwd, 'add', '--', filePath);
        if (typeof spec !== 'string') {
          await git(cwd, 'update-index', '--chmod=+x', '--', filePath);
        }
      }
      await $({ cwd, env: pinnedEnv() })`git commit --quiet -m ${message}`;
      return git(cwd, 'rev-parse', 'HEAD');
    };

    const initBare = async (name: string): Promise<string> => {
      const dir = path.join(root, `${name}.git`);
      await $`git init --quiet --bare -b ${defaultBranch} ${dir}`;
      await git(dir, 'config', 'core.logAllRefUpdates', 'true');
      return dir;
    };

    const upstream = await initBare('upstream');
    const origin = await initBare('origin');
    const publicFork = mode === 'standard' ? await initBare('public') : null;

    const upstreamDev = path.join(root, 'upstream-dev');
    await $`git clone --quiet ${upstream} ${upstreamDev}`;
    const seedCount = Math.max(1, options.upstreamCommits ?? 2);
    for (let i = 1; i <= seedCount; i++) {
      await commitFiles(
        upstreamDev,
        { [`src/file-${i}.txt`]: `upstream content ${i}\n` },
        `feat: upstream commit ${i}`
      );
    }
    await git(upstreamDev, 'push', '--quiet', 'origin', defaultBranch);

    await git(upstreamDev, 'push', '--quiet', origin, defaultBranch);
    if (publicFork) {
      await git(upstreamDev, 'push', '--quiet', publicFork, defaultBranch);
    }

    const work = path.join(root, 'work');
    await $`git clone --quiet ${origin} ${work}`;
    if (publicFork) {
      await git(work, 'remote', 'add', 'public', publicFork);
    }
    await git(work, 'remote', 'add', 'upstream', upstream);
    await git(work, 'remote', 'set-url', '--push', 'upstream', 'DISABLE');
    await git(work, 'fetch', '--quiet', 'upstream');
    if (publicFork) {
      await git(work, 'fetch', '--quiet', 'public');
    }
    await createConfigBranch(work, publicFork, upstream, mode);

    const originDev = path.join(root, 'origin-dev');
    await $`git clone --quiet ${origin} ${originDev}`;

    const fixture: MirrorFixture = {
      root,
      mode,
      defaultBranch,
      upstream,
      origin,
      publicFork,
      work,
      git,
      async commitOnUpstream(files, message = 'feat: upstream change') {
        await git(upstreamDev, 'pull', '--quiet', '--ff-only');
        const sha = await commitFiles(upstreamDev, files, message);
        await git(upstreamDev, 'push', '--quiet', 'origin', defaultBranch);
        return sha;
      },
      async commitOnOrigin(files, message = 'chore: mirror-only change') {
        await git(originDev, 'fetch', '--quiet', 'origin');
        await git(originDev, 'checkout', '--quiet', defaultBranch);
        await git(
          originDev,
          'reset',
          '--quiet',
          '--hard',
          `origin/${defaultBranch}`
        );
        const sha = await commitFiles(originDev, files, message);
        await git(originDev, 'push', '--quiet', 'origin', defaultBranch);
        return sha;
      },
      sha(repo, ref) {
        return git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
      },
      async subjects(repo, ref, range) {
        const out = await git(repo, 'log', '--format=%s', range ?? ref);
        return out ? out.split('\n') : [];
      },
      async pushCount(repo, ref) {
        const result = await $({
          cwd: repo,
          reject: false,
        })`git reflog show --format=%H ${ref}`;
        if (result.exitCode !== 0) return 0;
        return result.stdout.split('\n').filter(Boolean).length;
      },
      async fileAt(repo, ref, filePath) {
        const result = await $({
          cwd: repo,
          reject: false,
          stripFinalNewline: false,
        })`git show ${`${ref}:${filePath}`}`;
        return result.exitCode === 0 ? result.stdout : null;
      },
      async modeAt(repo, ref, filePath) {
        const out = await git(repo, 'ls-tree', ref, '--', filePath);
        return out.match(/^(\d+) /)?.[1] ?? null;
      },
      async cleanup() {
        restoreEnv();
        await rm(root, { recursive: true, force: true });
      },
    };
    return fixture;
  } catch (err) {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

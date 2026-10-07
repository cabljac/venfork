import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createMirrorFixture,
  type FixtureMode,
} from '../tests/harness/mirror-fixture.js';

/**
 * Stands up a throwaway venfork layout of local bare repos (upstream,
 * origin, public) plus a mirror clone under `os.tmpdir()`, and prints its
 * paths and the env the built CLI needs. JSON by default; `--shell` prints
 * `export` lines (`VF_*` paths included) and `venfork`/`vf_*` shell helpers
 * to source instead. A `gh` stub on
 * the printed PATH passes `gh auth status` and fails everything else, so no
 * drive reaches GitHub. Nothing is cleaned up: delete `root` when done.
 */
const USAGE =
  'usage: bun scripts/verify-fixture.ts [--no-public] [--commits <n>] [--shell]';

let mode: FixtureMode = 'standard';
let upstreamCommits = 2;
let shell = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--no-public') {
    mode = 'no-public';
  } else if (arg === '--shell') {
    shell = true;
  } else if (arg === '--commits') {
    const value = Number(args[++i]);
    if (!Number.isInteger(value) || value < 1) {
      console.error(USAGE);
      process.exit(2);
    }
    upstreamCommits = value;
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}

const fx = await createMirrorFixture({ mode, upstreamCommits });

const ghStubDir = path.join(fx.root, 'bin');
await mkdir(ghStubDir);
const gh = path.join(ghStubDir, 'gh');
await writeFile(
  gh,
  [
    '#!/bin/sh',
    '[ "$1 $2" = "auth status" ] && exit 0',
    'echo "gh stub: the verify fixture has no GitHub" >&2',
    'exit 1',
    '',
  ].join('\n')
);
await chmod(gh, 0o755);

// The harness has already stripped the caller's GIT_*, GH_* and VENFORK_*
// variables and set its own, so these are exactly the fixture's overrides.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (
    value !== undefined &&
    (key === 'HOME' || key.startsWith('GIT_') || key.startsWith('VENFORK_'))
  ) {
    env[key] = value;
  }
}

const paths = {
  root: fx.root,
  work: fx.work,
  upstream: fx.upstream,
  origin: fx.origin,
  publicFork: fx.publicFork,
  upstreamDev: path.join(fx.root, 'upstream-dev'),
  originDev: path.join(fx.root, 'origin-dev'),
  cli: path.resolve(import.meta.dir, '..', 'dist', 'index.js'),
};

if (shell) {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const vars: Record<string, string> = {
    ...env,
    VF_ROOT: paths.root,
    VF_WORK: paths.work,
    VF_UPSTREAM: paths.upstream,
    VF_ORIGIN: paths.origin,
    VF_PUBLIC: paths.publicFork ?? '',
    VF_UPSTREAM_DEV: paths.upstreamDev,
    VF_ORIGIN_DEV: paths.originDev,
    VF_CLI: paths.cli,
  };
  const branch = fx.defaultBranch;
  console.log(
    [
      'unset GITHUB_TOKEN GH_TOKEN XDG_CONFIG_HOME',
      `export PATH=${quote(ghStubDir)}:"$PATH"`,
      ...Object.entries(vars).map(
        ([key, value]) => `export ${key}=${quote(value)}`
      ),
      'venfork() { node "$VF_CLI" "$@"; }',
      `vf_tip() { git -C "$1" rev-parse "\${2:-${branch}}"; }`,
      `vf_pushes() { git -C "$1" reflog show --format=%H "\${2:-${branch}}" | wc -l | tr -d ' '; }`,
      // Answers "y" to one clack confirm, which reads keys only from a TTY.
      'vf_yes() { if script --version >/dev/null 2>&1; then (sleep 4; printf y) | script -qec "node $VF_CLI $*" /dev/null; else (sleep 4; printf y) | script -q /dev/null node "$VF_CLI" "$@"; fi; }',
      `vf_upstream_commit() { git -C "$VF_UPSTREAM_DEV" pull -q --ff-only && mkdir -p "$VF_UPSTREAM_DEV/$(dirname "$1")" && printf '%s\\n' "$2" > "$VF_UPSTREAM_DEV/$1" && git -C "$VF_UPSTREAM_DEV" add -- "$1" && git -C "$VF_UPSTREAM_DEV" commit -qm "\${3:-feat: upstream $1}" && git -C "$VF_UPSTREAM_DEV" push -q origin ${branch}; }`,
      `vf_origin_commit() { git -C "$VF_ORIGIN_DEV" fetch -q origin && git -C "$VF_ORIGIN_DEV" checkout -q ${branch} && git -C "$VF_ORIGIN_DEV" reset -q --hard origin/${branch} && mkdir -p "$VF_ORIGIN_DEV/$(dirname "$1")" && printf '%s\\n' "$2" > "$VF_ORIGIN_DEV/$1" && git -C "$VF_ORIGIN_DEV" add -- "$1" && git -C "$VF_ORIGIN_DEV" commit -qm "\${3:-chore: mirror $1}" && git -C "$VF_ORIGIN_DEV" push -q origin ${branch}; }`,
    ].join('\n')
  );
} else {
  console.log(
    JSON.stringify(
      {
        mode: fx.mode,
        defaultBranch: fx.defaultBranch,
        ...paths,
        ghStubDir,
        env,
        unset: ['GITHUB_TOKEN', 'GH_TOKEN', 'XDG_CONFIG_HOME'],
      },
      null,
      2
    )
  );
}

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MirrorFixture } from './mirror-fixture.js';

/** `owner/name` the fixture's origin answers to once {@link githubMirror} runs. */
export const MIRROR_REPO = 'acme/project-private';

/** `owner/name` upstream answers to with {@link githubMirror}'s `allRemotes`. */
export const UPSTREAM_REPO = 'upstream-org/project';

/** `owner/name` the public fork answers to with {@link githubMirror}'s `allRemotes`. */
export const PUBLIC_REPO = 'acme/project';

/**
 * One canned gh reply: the first route whose `match` is a substring of the
 * argv wins. Like gh, `--paginate` prints every page and a plain call only
 * the first; with `GH_FORCE_TTY` set, a `--jq` filter that does not end in
 * `tojson` prints each JSON line indented over several lines.
 */
export interface GhRoute {
  match: string;
  stdout?: string;
  /** Pages of output; `stdout` is one page. */
  pages?: string[];
  exitCode?: number;
}

/** The gh stub on PATH, with its routes and call log. */
export interface GhMirror {
  /** Replaces every route. */
  setRoutes(routes: GhRoute[]): Promise<void>;
  /** Each gh argv the stub received, joined by spaces. */
  calls(): Promise<string[]>;
}

const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv.join(' ');
fs.appendFileSync(process.env.GHSTUB_LOG, args + '\\n');
const routes = JSON.parse(fs.readFileSync(process.env.GHSTUB_ROUTES, 'utf8'));
const route = routes.find((r) => args.includes(r.match));
if (!route) {
  process.stderr.write('gh stub: no route for ' + args + '\\n');
  process.exit(1);
}
const pages = route.pages ?? [route.stdout ?? ''];
let out = argv.includes('--paginate') ? pages.join('\\n') : pages[0];
const jq = argv[argv.indexOf('--jq') + 1];
if (argv.includes('--jq') && process.env.GH_FORCE_TTY && !/\\|\\s*tojson$/.test(jq)) {
  out = out
    .split('\\n')
    .filter(Boolean)
    .map((line) => JSON.stringify(JSON.parse(line), null, 2))
    .join('\\n');
}
process.stdout.write(out);
process.exit(route.exitCode ?? 0);
`;

/**
 * Makes the fixture clone's origin look like `git@github.com:acme/project-private.git`
 * while git still reaches the local bare repo: a `core.sshCommand` stub maps
 * that path to `fx.origin`. With `allRemotes`, upstream and the public fork
 * get GitHub URLs the same way. Puts a gh stub that answers from canned
 * routes first on PATH; the fixture's `cleanup()` restores PATH.
 */
export async function githubMirror(
  fx: MirrorFixture,
  options: { allRemotes?: boolean } = {}
): Promise<GhMirror> {
  const remotes: Array<[string, string, string]> = [
    ['origin', MIRROR_REPO, fx.origin],
  ];
  if (options.allRemotes) {
    remotes.push(['upstream', UPSTREAM_REPO, fx.upstream]);
    if (fx.publicFork) remotes.push(['public', PUBLIC_REPO, fx.publicFork]);
  }
  const bin = path.join(fx.root, 'gh-mirror-bin');
  await mkdir(bin, { recursive: true });
  const ssh = path.join(bin, 'ssh-stub');
  await writeFile(
    ssh,
    [
      '#!/bin/sh',
      'for last; do :; done',
      `cmd=$(printf '%s' "$last" | sed ${remotes.map(([, repo, dir]) => `-e "s#'${repo}.git'#'${dir}'#"`).join(' ')})`,
      'exec sh -c "$cmd"',
      '',
    ].join('\n')
  );
  await chmod(ssh, 0o755);
  const gh = path.join(bin, 'gh');
  await writeFile(gh, GH_STUB);
  await chmod(gh, 0o755);
  const routesFile = path.join(bin, 'routes.json');
  const logFile = path.join(bin, 'calls.log');
  await writeFile(routesFile, '[]');
  await writeFile(logFile, '');
  await fx.git(fx.work, 'config', 'core.sshCommand', ssh);
  for (const [remote, repo] of remotes) {
    await fx.git(
      fx.work,
      'remote',
      'set-url',
      remote,
      `git@github.com:${repo}.git`
    );
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.GHSTUB_ROUTES = routesFile;
  process.env.GHSTUB_LOG = logFile;
  return {
    async setRoutes(routes) {
      await writeFile(routesFile, JSON.stringify(routes));
    },
    async calls() {
      return (await readFile(logFile, 'utf8')).split('\n').filter(Boolean);
    },
  };
}

/** One more open mirror PR for the same branch, for {@link approvalRoutes}. */
export interface ExtraPr {
  number: number;
  headSha?: string;
  baseRef?: string;
}

/** Options for {@link approvalRoutes}. */
export interface ApprovalScenario {
  branch: string;
  headSha: string;
  /** gh login running stage. */
  stager?: string;
  /** `gh api user` fails, as it does for a GitHub App token. */
  stagerFails?: boolean;
  author?: string;
  prNumber?: number;
  /** The PR base branch; `main`, the mirror default branch, when absent. */
  baseRef?: string;
  /** The repository the PR head lives in; the mirror when absent. */
  headRepo?: string;
  /** The PR head branch; `branch` when absent. */
  headRef?: string;
  /** Other open mirror PRs for the branch, listed before (newer than) the main one. */
  extraPrs?: ExtraPr[];
  /** The branch has no open mirror PR. */
  noPr?: boolean;
  reviews?: Array<{
    login: string;
    state: string;
    commitId?: string;
    type?: string;
  }>;
  /** Mirror permission per login; `write` when absent. */
  permissions?: Record<string, string>;
  checkRuns?: Array<{ name: string; status: string; conclusion?: string }>;
  statuses?: Array<{ context: string; state: string }>;
  /** Commit statuses split over pages; replaces `statuses`. */
  statusPages?: Array<Array<{ context: string; state: string }>>;
}

/** gh routes for the approval gate's reads, for one mirror PR scenario. */
export function approvalRoutes(scenario: ApprovalScenario): GhRoute[] {
  const prJson = (number: number, headSha: string, baseRef: string) => ({
    number,
    html_url: `https://github.com/${MIRROR_REPO}/pull/${number}`,
    state: 'open',
    head: {
      sha: headSha,
      ref: scenario.headRef ?? scenario.branch,
      repo: { full_name: scenario.headRepo ?? MIRROR_REPO },
    },
    base: {
      ref: baseRef,
      repo: { full_name: MIRROR_REPO, default_branch: 'main' },
    },
    user: { login: scenario.author ?? 'agent-author', type: 'User' },
  });
  const pr = scenario.prNumber ?? 7;
  const prs = [
    ...(scenario.extraPrs ?? []).map((extra) =>
      prJson(
        extra.number,
        extra.headSha ?? scenario.headSha,
        extra.baseRef ?? 'main'
      )
    ),
    prJson(pr, scenario.headSha, scenario.baseRef ?? 'main'),
  ];
  const lines = (items: unknown[]) =>
    items.map((item) => JSON.stringify(item)).join('\n');
  const permissions = scenario.permissions ?? {};
  const reviewers = (scenario.reviews ?? []).map((r) => r.login);
  return [
    scenario.stagerFails
      ? { match: 'api user', exitCode: 1 }
      : {
          match: 'api user',
          stdout: JSON.stringify({ login: scenario.stager ?? 'stager' }),
        },
    {
      match: `repos/${MIRROR_REPO}/pulls?head=`,
      stdout: JSON.stringify(scenario.noPr ? [] : prs),
    },
    ...prs.map((item) => ({
      match: `repos/${MIRROR_REPO}/pulls/${item.number}/reviews`,
      stdout: lines(
        (scenario.reviews ?? []).map((r) => ({
          user: { login: r.login, type: r.type ?? 'User' },
          state: r.state,
          commit_id: r.commitId ?? scenario.headSha,
        }))
      ),
    })),
    ...prs.map((item) => ({
      match: `repos/${MIRROR_REPO}/pulls/${item.number}`,
      stdout: JSON.stringify(item),
    })),
    ...reviewers.map((login) => ({
      match: `repos/${MIRROR_REPO}/collaborators/${login}/permission`,
      stdout: JSON.stringify({ permission: permissions[login] ?? 'write' }),
    })),
    {
      match: `/check-runs`,
      stdout: lines(scenario.checkRuns ?? []),
    },
    {
      match: `/status`,
      pages: (scenario.statusPages ?? [scenario.statuses ?? []]).map(lines),
    },
  ];
}

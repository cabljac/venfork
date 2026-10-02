import * as p from '@clack/prompts';
import { $ } from 'execa';
import { readVenforkConfigFromRepo, type VenforkConfig } from '../config.js';
import { checkGhAuth, getDefaultBranch } from '../git.js';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';
import { cronMaxIntervalMinutes } from '../shared/cron.js';
import { checkDivergence } from '../shared/divergence.js';
import { isManagedCommit } from '../shared/managed-commit.js';
import { netExec, netFailureReason } from '../shared/net.js';
import { parseRepoPath } from '../utils.js';
import { VENFORK_VERSION } from '../version.js';
import { generateSyncWorkflow } from '../workflow.js';

/** Result of one doctor check. `'skipped'` means it could not be evaluated. */
export interface DoctorCheck {
  id: string;
  ok: boolean | 'skipped';
  detail: string;
  fix?: string;
}

/** Options for {@link runDoctorChecks}. */
export interface DoctorOptions {
  cwd?: string;
  /** Clock used by the cron-age check. */
  now?: Date;
}

interface Remote {
  fetch: string;
  push: string;
}

interface LastRun {
  conclusion: string | null;
  status: string;
  url: string;
  createdAt: string;
}

const SYNC_WORKFLOW_FILE = 'venfork-sync.yml';

function sameRepo(a: string, b: string): boolean {
  const pa = parseRepoPath(a);
  const pb = parseRepoPath(b);
  return pa && pb ? pa === pb : a.trim() === b.trim();
}

function formatAge(minutes: number): string {
  if (minutes < 120) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * Runs every health check against the mirror clone in `cwd`. Reads only,
 * apart from fetching the remotes and the venfork-config branch. GitHub
 * checks (token, last-run, cron-age) report `'skipped'` when gh is not
 * authenticated or origin is not a GitHub repository.
 */
export async function runDoctorChecks(
  options: DoctorOptions = {}
): Promise<DoctorCheck[]> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const git = (strict: boolean) => $({ cwd, reject: strict });
  const checks: DoctorCheck[] = [];
  const skip = (id: string, detail: string): void => {
    checks.push({ id, ok: 'skipped', detail });
  };
  const laterIds = [
    'remotes',
    'mode',
    'invariant',
    'divergence',
    'preserve',
    'workflow',
    'token',
    'last-run',
    'cron-age',
  ];

  const inRepo = await git(false)`git rev-parse --git-dir`;
  const config: VenforkConfig | null =
    inRepo.exitCode === 0 ? await readVenforkConfigFromRepo(cwd) : null;
  if (!config) {
    checks.push({
      id: 'repo',
      ok: false,
      detail:
        inRepo.exitCode === 0
          ? 'venfork-config branch not found or unreadable on origin'
          : `${cwd} is not a git repository`,
      fix: 'Run from a clone made by `venfork setup` or `venfork clone`.',
    });
    for (const id of laterIds) skip(id, 'needs a readable venfork config');
    return checks;
  }
  checks.push({ id: 'repo', ok: true, detail: 'venfork-config readable' });

  const noPublic = config.mode === 'no-public';
  const remotes: Record<string, Remote> = {};
  const remoteList = await git(false)`git remote -v`;
  for (const line of remoteList.stdout.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    remotes[name] ??= { fetch: '', push: '' };
    remotes[name][kind as 'fetch' | 'push'] = url;
  }

  const remoteProblems: string[] = [];
  if (!remotes.origin) remoteProblems.push('origin missing');
  if (!remotes.upstream) {
    remoteProblems.push('upstream missing');
  } else {
    if (!sameRepo(remotes.upstream.fetch, config.upstreamUrl)) {
      remoteProblems.push(
        `upstream is ${remotes.upstream.fetch}, config says ${config.upstreamUrl}`
      );
    }
    if (remotes.upstream.push !== 'DISABLE') {
      remoteProblems.push(
        `upstream push URL is ${remotes.upstream.push}, expected DISABLE`
      );
    }
  }
  if (
    remotes.public &&
    config.publicForkUrl &&
    !sameRepo(remotes.public.fetch, config.publicForkUrl)
  ) {
    remoteProblems.push(
      `public is ${remotes.public.fetch}, config says ${config.publicForkUrl}`
    );
  }
  checks.push(
    remoteProblems.length === 0
      ? { id: 'remotes', ok: true, detail: 'origin and upstream match config' }
      : {
          id: 'remotes',
          ok: false,
          detail: remoteProblems.join('; '),
          fix: 'Fix with `git remote set-url` (upstream push: `git remote set-url --push upstream DISABLE`).',
        }
  );

  const modeProblems: string[] = [];
  if (noPublic) {
    if (remotes.public) modeProblems.push('a public remote exists');
    if (config.publicForkUrl) modeProblems.push('config has a publicForkUrl');
  } else {
    if (!remotes.public) modeProblems.push('no public remote');
    if (!config.publicForkUrl) modeProblems.push('config has no publicForkUrl');
  }
  const modeName = noPublic ? 'no-public' : 'standard';
  checks.push(
    modeProblems.length === 0
      ? { id: 'mode', ok: true, detail: `${modeName} layout` }
      : {
          id: 'mode',
          ok: false,
          detail: `mode is ${modeName} but ${modeProblems.join(' and ')}`,
          fix: 'Re-run `venfork clone` or `venfork setup` to restore the layout.',
        }
  );

  const fetchRemotes = [
    'origin',
    'upstream',
    ...(noPublic ? [] : ['public']),
  ].filter((name) => remotes[name]);
  const fetched = await netExec(cwd, {
    bufferOutput: true,
  })`git fetch --quiet --multiple ${fetchRemotes}`;
  const defaultBranch = await getDefaultBranch('upstream', cwd);
  const revParse = async (ref: string): Promise<string> => {
    const result = await git(
      false
    )`git rev-parse --verify ${`${ref}^{commit}`}`;
    return result.exitCode === 0 ? result.stdout.trim() : '';
  };
  const originTip = await revParse(`origin/${defaultBranch}`);
  const upstreamTip = await revParse(`upstream/${defaultBranch}`);
  if (fetched.exitCode !== 0 || !originTip || !upstreamTip) {
    const detail =
      fetched.exitCode !== 0
        ? `git fetch failed: ${netFailureReason(fetched)}`
        : `origin/${defaultBranch} or upstream/${defaultBranch} not found`;
    for (const id of ['invariant', 'divergence', 'preserve', 'workflow']) {
      checks.push({ id, ok: false, detail });
    }
  } else {
    const managed = await isManagedCommit(originTip, cwd);
    const base = managed ? await revParse(`${originTip}^`) : originTip;
    const onUpstream =
      base !== '' &&
      (
        await git(
          false
        )`git merge-base --is-ancestor ${base} ${`upstream/${defaultBranch}`}`
      ).exitCode === 0;
    if (!onUpstream) {
      checks.push({
        id: 'invariant',
        ok: false,
        detail: `origin/${defaultBranch} is not an upstream commit plus at most one venfork-managed commit`,
        fix: 'Resolve the divergence below, then run `venfork sync`.',
      });
    } else {
      const behind =
        base === upstreamTip
          ? 0
          : Number(
              (
                await git(
                  false
                )`git rev-list --count ${`${base}..upstream/${defaultBranch}`}`
              ).stdout.trim()
            );
      const shape = managed ? 'upstream + 1 managed commit' : 'upstream (+0)';
      checks.push({
        id: 'invariant',
        ok: true,
        detail:
          behind > 0
            ? `${shape}; ${behind} upstream commit(s) not synced yet`
            : shape,
      });
    }

    const preserveAllowed = new Set(config.preserve ?? []);
    const divergences: string[] = [];
    const remotesToCheck: Array<[string, boolean]> = [['origin', true]];
    if (!noPublic && remotes.public) remotesToCheck.push(['public', false]);
    let divergenceError = '';
    for (const [remote, allowPreserved] of remotesToCheck) {
      try {
        const result = await checkDivergence({
          remote,
          defaultBranch,
          allowPreserved,
          preserveAllowed,
          cwd,
        });
        if (result.count > 0) {
          divergences.push(
            `${remote}/${defaultBranch}: ${result.count} commit(s) touching ${result.files.join(', ') || '(no files)'}`
          );
        }
      } catch (err) {
        divergenceError = err instanceof Error ? err.message : String(err);
      }
    }
    if (divergenceError) {
      checks.push({ id: 'divergence', ok: false, detail: divergenceError });
    } else {
      checks.push(
        divergences.length === 0
          ? { id: 'divergence', ok: true, detail: 'no divergent commits' }
          : {
              id: 'divergence',
              ok: false,
              detail: divergences.join('; '),
              fix: 'Move the commits to a feature branch, or `venfork preserve add <path>` for mirror-only files. Sync aborts until then.',
            }
      );
    }

    const preserveList = config.preserve ?? [];
    const missing: string[] = [];
    for (const preservePath of preserveList) {
      const exists = await git(
        false
      )`git cat-file -e ${`${originTip}:${preservePath}`}`;
      if (exists.exitCode !== 0) missing.push(preservePath);
    }
    checks.push(
      missing.length === 0
        ? {
            id: 'preserve',
            ok: true,
            detail:
              preserveList.length === 0
                ? 'no preserved paths'
                : `${preserveList.length} preserved path(s) present`,
          }
        : {
            id: 'preserve',
            ok: false,
            detail: `missing on origin/${defaultBranch}: ${missing.join(', ')}`,
            fix: `Commit the file(s) to origin/${defaultBranch}, or \`venfork preserve remove ${missing.join(' ')}\`. Sync aborts until then.`,
          }
    );

    const schedule = config.schedule;
    const scheduleActive = Boolean(schedule?.enabled && schedule.cron);
    const onOrigin = await $({
      cwd,
      reject: false,
      stripFinalNewline: false,
    })`git show ${`${originTip}:${SYNC_WORKFLOW_PATH}`}`;
    const workflowOnOrigin = onOrigin.exitCode === 0 ? onOrigin.stdout : null;
    if (scheduleActive && schedule) {
      const expected = generateSyncWorkflow(
        schedule.cron,
        noPublic ? 'no-public' : 'standard',
        VENFORK_VERSION
      );
      if (workflowOnOrigin === null) {
        checks.push({
          id: 'workflow',
          ok: false,
          detail: `${SYNC_WORKFLOW_PATH} missing on origin/${defaultBranch}; scheduled sync will not run`,
          fix: 'Run `venfork sync`.',
        });
      } else if (workflowOnOrigin !== expected) {
        checks.push({
          id: 'workflow',
          ok: false,
          detail: `${SYNC_WORKFLOW_PATH} is stale (config or venfork ${VENFORK_VERSION} would write different YAML)`,
          fix: 'Run `venfork sync`.',
        });
      } else {
        checks.push({
          id: 'workflow',
          ok: true,
          detail: `up to date (venfork@${VENFORK_VERSION}, cron '${schedule.cron}')`,
        });
      }
    } else {
      checks.push(
        workflowOnOrigin === null
          ? { id: 'workflow', ok: true, detail: 'schedule disabled' }
          : {
              id: 'workflow',
              ok: false,
              detail: `schedule disabled but ${SYNC_WORKFLOW_PATH} is still on origin/${defaultBranch}`,
              fix: 'Run `venfork sync` (or `venfork schedule disable`).',
            }
      );
    }
  }

  const schedule = config.schedule;
  const scheduleActive = Boolean(schedule?.enabled && schedule.cron);
  const mirrorRepo = remotes.origin ? parseRepoPath(remotes.origin.fetch) : '';
  const ghIds = ['token', 'last-run', 'cron-age'];
  if (!scheduleActive || !schedule) {
    for (const id of ghIds) {
      checks.push({ id, ok: true, detail: 'schedule disabled' });
    }
    return checks;
  }
  if (!mirrorRepo) {
    for (const id of ghIds) skip(id, 'origin is not a GitHub repository');
    return checks;
  }
  if (!(await checkGhAuth())) {
    for (const id of ghIds) skip(id, 'gh is not authenticated');
    return checks;
  }

  if (noPublic) {
    checks.push({
      id: 'token',
      ok: true,
      detail: 'not needed in no-public mode',
    });
  } else {
    const secrets = await netExec(cwd, {
      bufferOutput: true,
    })`gh secret list --repo ${mirrorRepo} --json name`;
    if (secrets.exitCode !== 0) {
      skip(
        'token',
        `cannot list secrets on ${mirrorRepo}: ${netFailureReason(secrets)}`
      );
    } else {
      let names: string[] = [];
      try {
        names = (
          JSON.parse(secrets.stdout ?? '') as Array<{ name: string }>
        ).map((entry) => entry.name);
      } catch {
        names = [];
      }
      checks.push(
        names.includes('VENFORK_PUSH_TOKEN')
          ? { id: 'token', ok: true, detail: 'VENFORK_PUSH_TOKEN is set' }
          : {
              id: 'token',
              ok: false,
              detail: `VENFORK_PUSH_TOKEN is not set on ${mirrorRepo}; scheduled pushes to the public fork will fail`,
              fix: `gh secret set VENFORK_PUSH_TOKEN --repo ${mirrorRepo} --body "$(gh auth token)"`,
            }
      );
    }
  }

  const runs = await netExec(cwd, {
    bufferOutput: true,
  })`gh run list --repo ${mirrorRepo} --workflow ${SYNC_WORKFLOW_FILE} --limit 1 --json conclusion,status,url,createdAt`;
  let lastRun: LastRun | null = null;
  if (runs.exitCode !== 0) {
    skip('last-run', `cannot list runs: ${netFailureReason(runs)}`);
    skip('cron-age', 'needs the last run');
    return checks;
  }
  try {
    lastRun = (JSON.parse(runs.stdout ?? '') as LastRun[])[0] ?? null;
  } catch {
    lastRun = null;
  }
  if (!lastRun) {
    checks.push({
      id: 'last-run',
      ok: true,
      detail: 'no runs yet',
    });
    skip('cron-age', 'no runs yet');
    return checks;
  }
  const failed =
    lastRun.status === 'completed' &&
    lastRun.conclusion !== 'success' &&
    lastRun.conclusion !== 'skipped';
  checks.push(
    failed
      ? {
          id: 'last-run',
          ok: false,
          detail: `last run ${lastRun.conclusion ?? 'failed'}: ${lastRun.url}`,
          fix: 'Open the run log; run `venfork sync` locally to see the same error.',
        }
      : {
          id: 'last-run',
          ok: true,
          detail: `last run ${lastRun.conclusion ?? lastRun.status}: ${lastRun.url}`,
        }
  );

  const interval = cronMaxIntervalMinutes(schedule.cron, now);
  const createdAt = Date.parse(lastRun.createdAt);
  if (interval === null || Number.isNaN(createdAt)) {
    skip('cron-age', 'cannot work out the cron interval');
    return checks;
  }
  const ageMinutes = (now.getTime() - createdAt) / 60_000;
  // GitHub delays scheduled runs under load, so tiny intervals get a floor.
  const limit = Math.max(2 * interval, 60);
  checks.push(
    ageMinutes <= limit
      ? {
          id: 'cron-age',
          ok: true,
          detail: `last run ${formatAge(ageMinutes)} ago (cron fires at least every ${formatAge(interval)})`,
        }
      : {
          id: 'cron-age',
          ok: false,
          detail: `last run ${formatAge(ageMinutes)} ago, but cron fires at least every ${formatAge(interval)}`,
          fix: 'GitHub pauses scheduled workflows after 60 days without repository activity. Re-enable it in the Actions tab or run `gh workflow run venfork-sync.yml`.',
        }
  );
  return checks;
}

/**
 * Doctor command: prints the health checks as a table (or JSON with
 * `json`). Returns false when any check failed so the caller can exit 1.
 */
export async function doctorCommand(
  options: { json?: boolean; cwd?: string } = {}
): Promise<boolean> {
  const checks = await runDoctorChecks({ cwd: options.cwd });
  const healthy = checks.every((check) => check.ok !== false);
  if (options.json) {
    console.log(JSON.stringify(checks, null, 2));
    return healthy;
  }

  p.intro('🩺 Venfork Doctor');
  const width = Math.max(...checks.map((check) => check.id.length));
  const lines = checks.map((check) => {
    const mark = check.ok === true ? '✓' : check.ok === false ? '✗' : '-';
    const row = `${mark} ${check.id.padEnd(width)}  ${check.detail}`;
    return check.fix && check.ok === false
      ? `${row}\n  ${' '.repeat(width)}  fix: ${check.fix}`
      : row;
  });
  p.note(lines.join('\n'), 'Checks');
  p.outro(healthy ? '✨ All checks passed' : '❌ Some checks failed');
  return healthy;
}

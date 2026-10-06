import * as p from '@clack/prompts';
import { $ } from 'execa';
import {
  preserveRemoveHint,
  readVenforkConfigFromRepo,
  type VenforkConfig,
} from '../config.js';
import {
  ConfigError,
  PinDowngradeError,
  UNMIGRATED_MIRROR_STEPS,
} from '../errors.js';
import { checkGhAuth, getDefaultBranch, getRemotes } from '../git.js';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';
import {
  cronMaxIntervalMinutes,
  isValidCronExpression,
} from '../shared/cron.js';
import { checkDivergence } from '../shared/divergence.js';
import { isManagedCommit } from '../shared/managed-commit.js';
import { buildOriginTip } from '../shared/mirror-commit.js';
import { netExec, netFailureReason } from '../shared/net.js';
import {
  OPEN_WORKFLOWS_WARNING,
  pushTokenCommand,
} from '../shared/push-token.js';
import {
  compareSemver,
  isUnpinnedWorkflow,
  pinnedVenforkVersion,
} from '../shared/semver.js';
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

/** First git error line of a multi-line stderr, so table rows stay one line. */
function oneLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? '';
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
  return (await runDoctor(options)).checks;
}

async function runDoctor(
  options: DoctorOptions
): Promise<{ checks: DoctorCheck[]; config: VenforkConfig | null }> {
  let config: VenforkConfig | null = null;
  const checks = await collectChecks(options, (read) => {
    config = read;
  });
  return { checks, config };
}

async function collectChecks(
  options: DoctorOptions,
  onConfig: (config: VenforkConfig) => void
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
  let config: VenforkConfig | null = null;
  let configProblem = '';
  let configFix =
    'Run from a clone made by `venfork setup` or `venfork clone`.';
  if (inRepo.exitCode !== 0) {
    configProblem = `${cwd} is not a git repository`;
  } else {
    try {
      config = await readVenforkConfigFromRepo(cwd, { allowInvalidCron: true });
      if (!config) {
        configProblem = 'venfork-config branch not found on origin';
        configFix =
          'Re-run `venfork setup <upstream> <mirror-name>` from the parent directory of this clone; for existing repos it repairs the clone and pushes the venfork-config branch.';
      }
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      if (err.reason === 'fetch') {
        configProblem = `fetch failed: ${oneLine(err.message)}`;
        configFix = 'Check that origin is reachable: `git ls-remote origin`.';
      } else {
        configProblem = oneLine(err.message);
        configFix =
          'Fix .venfork/config.json on the venfork-config branch of origin.';
      }
    }
  }
  if (config) onConfig(config);
  if (!config) {
    checks.push({
      id: 'repo',
      ok: false,
      detail: configProblem,
      fix: configFix,
    });
    for (const id of laterIds) skip(id, 'needs a readable venfork config');
    return checks;
  }
  const cronValue = config.schedule?.cron ?? '';
  const cronInvalid =
    config.schedule !== undefined && !isValidCronExpression(cronValue);
  checks.push(
    cronInvalid
      ? {
          id: 'repo',
          ok: false,
          detail: `venfork-config schedule.cron '${cronValue}' is not a valid 5-field cron expression`,
          fix: 'venfork schedule set "<cron>" (or venfork schedule disable)',
        }
      : { id: 'repo', ok: true, detail: 'venfork-config readable' }
  );

  const noPublic = config.mode === 'no-public';
  const remotes: Record<string, Remote> = await getRemotes(cwd);

  const remoteProblems: string[] = [];
  const remoteFixes: string[] = [];
  if (!remotes.origin) {
    remoteProblems.push('origin missing');
    remoteFixes.push('git remote add origin <private mirror URL>');
  }
  if (!remotes.upstream) {
    remoteProblems.push('upstream missing');
    remoteFixes.push(
      `git remote add upstream ${config.upstreamUrl} && git remote set-url --push upstream DISABLE`
    );
  } else {
    if (!sameRepo(remotes.upstream.fetch, config.upstreamUrl)) {
      remoteProblems.push(
        `upstream is ${remotes.upstream.fetch}, config says ${config.upstreamUrl}`
      );
      remoteFixes.push(`git remote set-url upstream ${config.upstreamUrl}`);
    }
    if (remotes.upstream.push !== 'DISABLE') {
      remoteProblems.push(
        `upstream push URL is ${remotes.upstream.push}, expected DISABLE`
      );
      remoteFixes.push('git remote set-url --push upstream DISABLE');
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
    remoteFixes.push(`git remote set-url public ${config.publicForkUrl}`);
  }

  const fetchRemotes = [
    'origin',
    'upstream',
    ...(noPublic ? [] : ['public']),
  ].filter((name) => remotes[name]);
  const haveBothRemotes = Boolean(remotes.origin && remotes.upstream);
  const fetched = haveBothRemotes
    ? await netExec(cwd, {
        bufferOutput: true,
      })`git fetch --quiet --multiple ${fetchRemotes}`
    : null;
  const fetchFailed = fetched !== null && fetched.exitCode !== 0;
  if (fetched && fetchFailed) {
    remoteProblems.push(
      `git fetch failed: ${oneLine(netFailureReason(fetched))}`
    );
    remoteFixes.push(
      `Check the remote URLs and your credentials, then retry \`git fetch --multiple ${fetchRemotes.join(' ')}\``
    );
  }
  checks.push(
    remoteProblems.length === 0
      ? { id: 'remotes', ok: true, detail: 'origin and upstream match config' }
      : {
          id: 'remotes',
          ok: false,
          detail: remoteProblems.join('; '),
          fix: remoteFixes.join('; '),
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

  const gitStateIds = ['invariant', 'divergence', 'preserve', 'workflow'];
  const revParse = async (ref: string): Promise<string> => {
    const result = await git(
      false
    )`git rev-parse --verify ${`${ref}^{commit}`}`;
    return result.exitCode === 0 ? result.stdout.trim() : '';
  };
  let defaultBranch = '';
  let defaultBranchError = '';
  if (haveBothRemotes && !fetchFailed) {
    try {
      defaultBranch = await getDefaultBranch('upstream', cwd);
    } catch (err) {
      defaultBranchError = oneLine(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  const originTip = defaultBranch
    ? await revParse(`refs/remotes/origin/${defaultBranch}`)
    : '';
  const upstreamTip = defaultBranch
    ? await revParse(`refs/remotes/upstream/${defaultBranch}`)
    : '';
  const publicTip =
    defaultBranch && !noPublic && remotes.public
      ? await revParse(`refs/remotes/public/${defaultBranch}`)
      : '';
  if (!haveBothRemotes) {
    for (const id of gitStateIds) {
      skip(id, 'needs the origin and upstream remotes');
    }
  } else if (fetchFailed) {
    for (const id of gitStateIds) skip(id, 'needs a successful git fetch');
  } else if (defaultBranchError) {
    for (const id of gitStateIds) {
      checks.push({ id, ok: false, detail: defaultBranchError });
    }
  } else if (!originTip || !upstreamTip) {
    const detail = `origin/${defaultBranch} or upstream/${defaultBranch} not found`;
    for (const id of gitStateIds) {
      checks.push({ id, ok: false, detail });
    }
  } else {
    const preserveAllowed = new Set(config.preserve ?? []);
    const divergences: string[] = [];
    const remotesToCheck: Array<[string, string, boolean]> = [
      ['origin', originTip, true],
    ];
    if (!noPublic && remotes.public) {
      remotesToCheck.push(['public', publicTip, false]);
    }
    let divergenceError = '';
    let originDiverged = true;
    for (const [remote, tip, allowPreserved] of remotesToCheck) {
      try {
        const result = await checkDivergence({
          base: upstreamTip,
          tip,
          allowPreserved,
          preserveAllowed,
          cwd,
        });
        if (remote === 'origin') originDiverged = result.count > 0;
        if (result.count > 0) {
          divergences.push(
            `${remote}/${defaultBranch}: ${result.count} commit(s) touching ${result.files.join(', ') || '(no files)'}`
          );
        }
      } catch (err) {
        divergenceError = oneLine(
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const managed = await isManagedCommit(originTip, cwd, preserveAllowed);
    const base = managed ? await revParse(`${originTip}^`) : originTip;
    const onUpstream =
      base !== '' &&
      (await git(false)`git merge-base --is-ancestor ${base} ${upstreamTip}`)
        .exitCode === 0;
    if (!onUpstream && !originDiverged && !divergenceError) {
      const stacked = Number(
        (
          await git(
            false
          )`git rev-list --count ${`${upstreamTip}..${originTip}`}`
        ).stdout.trim()
      );
      checks.push({
        id: 'invariant',
        ok: false,
        detail: `origin/${defaultBranch} has ${stacked} venfork-managed or preserve-only commits above upstream instead of one`,
        fix: `Run \`venfork sync\` to fold the ${stacked} commits into one managed commit.`,
      });
    } else if (!onUpstream) {
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
                )`git rev-list --count ${`${base}..${upstreamTip}`}`
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
    const invalidPreserve = config.invalidPreserve ?? [];
    if (invalidPreserve.length > 0) {
      checks.push({
        id: 'preserve',
        ok: false,
        detail: `invalid entries (single files only): ${invalidPreserve.join(', ')}`,
        fix: invalidPreserve
          .map((entry) => preserveRemoveHint(entry))
          .join('; '),
      });
    } else {
      // The same builder sync runs, so doctor cannot pass what sync refuses.
      // Nothing is pushed; the objects it writes are unreachable.
      try {
        await buildOriginTip({
          config,
          defaultBranch,
          upstreamTip,
          previousMirrorTip: originTip,
          cwd,
        });
        checks.push({
          id: 'preserve',
          ok: true,
          detail:
            preserveList.length === 0
              ? 'no preserved paths'
              : `${preserveList.length} preserved path(s) restorable on the next sync`,
        });
      } catch (err) {
        if (err instanceof PinDowngradeError) {
          skip(
            'preserve',
            'needs a venfork at least as new as the pin on origin'
          );
        } else {
          const message = err instanceof Error ? err.message : String(err);
          checks.push({
            id: 'preserve',
            ok: false,
            detail: message
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .join(' '),
            fix: 'Fix the entry as the detail says, then run `venfork sync`. Sync aborts until then.',
          });
        }
      }
    }

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
        const pinned = pinnedVenforkVersion(workflowOnOrigin);
        const newer =
          pinned !== null && (compareSemver(pinned, VENFORK_VERSION) ?? 0) > 0;
        checks.push(
          newer
            ? {
                id: 'workflow',
                ok: false,
                detail: `origin pins venfork ${pinned}, newer than this CLI (${VENFORK_VERSION}); sync refuses to downgrade it`,
                fix: `Upgrade venfork to ${pinned} or later.`,
              }
            : isUnpinnedWorkflow(workflowOnOrigin)
              ? {
                  id: 'workflow',
                  ok: false,
                  detail: `${SYNC_WORKFLOW_PATH} is not pinned to a venfork version, so it predates venfork 0.11; every scheduled run fails until the mirror is migrated`,
                  fix: UNMIGRATED_MIRROR_STEPS,
                }
              : {
                  id: 'workflow',
                  ok: false,
                  detail: `${SYNC_WORKFLOW_PATH} is stale (origin pins venfork ${pinned ?? 'unknown'}; config or venfork ${VENFORK_VERSION} would write different YAML)`,
                  fix: 'Run `venfork sync`.',
                }
        );
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
  if (cronInvalid) {
    for (const id of ghIds) {
      skip(id, `schedule.cron '${cronValue}' is invalid`);
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

  const secrets = await netExec(cwd, {
    bufferOutput: true,
  })`gh secret list --repo ${mirrorRepo} --json name`;
  if (secrets.exitCode !== 0) {
    skip(
      'token',
      `cannot list secrets on ${mirrorRepo}: ${oneLine(netFailureReason(secrets))}`
    );
  } else {
    let names: string[] = [];
    try {
      names = (JSON.parse(secrets.stdout ?? '') as Array<{ name: string }>).map(
        (entry) => entry.name
      );
    } catch {
      names = [];
    }
    const consequence = noPublic
      ? 'pushes of upstream commits that change .github/workflows will fail'
      : 'scheduled pushes to the public fork, and of upstream commits that change .github/workflows, will fail';
    const openWorkflows =
      (config.enabledWorkflows ?? []).length === 0 &&
      (config.disabledWorkflows ?? []).length === 0;
    checks.push(
      names.includes('VENFORK_PUSH_TOKEN')
        ? {
            id: 'token',
            ok: true,
            detail: openWorkflows
              ? 'VENFORK_PUSH_TOKEN is set; every upstream workflow on the mirror can read it'
              : 'VENFORK_PUSH_TOKEN is set',
            ...(openWorkflows ? { fix: OPEN_WORKFLOWS_WARNING } : {}),
          }
        : {
            id: 'token',
            ok: false,
            detail: `VENFORK_PUSH_TOKEN is not set on ${mirrorRepo}; ${consequence} (a fine-grained token limited to the mirror${noPublic ? '' : ' and the public fork'} with Contents and Workflows write; never \`gh auth token\`)`,
            fix: pushTokenCommand(mirrorRepo),
          }
    );
  }

  const runs = await netExec(cwd, {
    bufferOutput: true,
  })`gh run list --repo ${mirrorRepo} --workflow ${SYNC_WORKFLOW_FILE} --limit 1 --json conclusion,status,url,createdAt`;
  let lastRun: LastRun | null = null;
  if (runs.exitCode !== 0) {
    skip('last-run', `cannot list runs: ${oneLine(netFailureReason(runs))}`);
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
  const completed = lastRun.status === 'completed';
  const failed =
    completed &&
    lastRun.conclusion !== 'success' &&
    lastRun.conclusion !== 'skipped';
  const outcome = completed
    ? lastRun.conclusion || 'completed'
    : lastRun.status.replaceAll('_', ' ');
  checks.push(
    failed
      ? {
          id: 'last-run',
          ok: false,
          detail: `last run ${lastRun.conclusion || 'failed'}: ${lastRun.url}`,
          fix: 'Open the run log; run `venfork sync` locally to see the same error.',
        }
      : {
          id: 'last-run',
          ok: true,
          detail: `last run ${outcome}: ${lastRun.url}`,
        }
  );

  const workflowView = await netExec(cwd, {
    bufferOutput: true,
  })`gh api ${`repos/${mirrorRepo}/actions/workflows/${SYNC_WORKFLOW_FILE}`} --jq .state`;
  if (workflowView.exitCode !== 0) {
    skip(
      'cron-age',
      `cannot read the workflow state: ${oneLine(netFailureReason(workflowView))}`
    );
    return checks;
  }
  const workflowState = (workflowView.stdout ?? '').trim();
  if (workflowState !== 'active') {
    checks.push({
      id: 'cron-age',
      ok: false,
      detail: `${SYNC_WORKFLOW_FILE} is ${workflowState ? `disabled (${workflowState})` : 'in an unknown state'}`,
      fix: `Enable ${SYNC_WORKFLOW_FILE} in the mirror's Actions tab, or run \`gh workflow enable ${SYNC_WORKFLOW_FILE} --repo ${mirrorRepo}\`.`,
    });
    return checks;
  }

  const scheduledRuns = await netExec(cwd, {
    bufferOutput: true,
  })`gh run list --repo ${mirrorRepo} --workflow ${SYNC_WORKFLOW_FILE} --event schedule --limit 1 --json conclusion,status,url,createdAt`;
  if (scheduledRuns.exitCode !== 0) {
    skip(
      'cron-age',
      `cannot list scheduled runs: ${oneLine(netFailureReason(scheduledRuns))}`
    );
    return checks;
  }
  let lastScheduled: LastRun | null = null;
  try {
    lastScheduled =
      (JSON.parse(scheduledRuns.stdout ?? '') as LastRun[])[0] ?? null;
  } catch {
    lastScheduled = null;
  }
  if (!lastScheduled) {
    skip('cron-age', 'no scheduled runs yet');
    return checks;
  }

  const interval = cronMaxIntervalMinutes(schedule.cron, now);
  const createdAt = Date.parse(lastScheduled.createdAt);
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
          detail: `last scheduled run ${formatAge(ageMinutes)} ago (cron fires at least every ${formatAge(interval)})`,
        }
      : {
          id: 'cron-age',
          ok: false,
          detail: `last scheduled run ${formatAge(ageMinutes)} ago, but cron fires at least every ${formatAge(interval)}`,
          fix: `GitHub is delaying or dropping scheduled runs; check \`gh run list --repo ${mirrorRepo} --workflow ${SYNC_WORKFLOW_FILE} --event schedule\` and run \`venfork sync\` locally to catch up meanwhile.`,
        }
  );
  return checks;
}

/** Link maps recorded in venfork-config, as printed by doctor. */
export interface DoctorLinks {
  shippedBranches: NonNullable<VenforkConfig['shippedBranches']>;
  pulledPrs: NonNullable<VenforkConfig['pulledPrs']>;
  shippedIssues: NonNullable<VenforkConfig['shippedIssues']>;
  pulledIssues: NonNullable<VenforkConfig['pulledIssues']>;
}

/** Collects the four link maps from a config, defaulting each to empty. */
export function doctorLinks(config: VenforkConfig): DoctorLinks {
  return {
    shippedBranches: config.shippedBranches ?? {},
    pulledPrs: config.pulledPrs ?? {},
    shippedIssues: config.shippedIssues ?? {},
    pulledIssues: config.pulledIssues ?? {},
  };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

/** Renders the non-empty link maps as text blocks; empty when there are none. */
export function formatLinks(links: DoctorLinks): string {
  const blocks: string[] = [];
  const add = (title: string, lines: string[]): void => {
    if (lines.length > 0) blocks.push(`${title}:\n${lines.join('\n')}`);
  };
  add(
    'Shipped branches',
    Object.entries(links.shippedBranches).map(
      ([branch, entry]) =>
        `  ${branch} -> ${entry.upstreamPrUrl} (${formatDate(entry.shippedAt)})`
    )
  );
  add(
    'Pulled PRs',
    Object.entries(links.pulledPrs).map(
      ([branch, entry]) =>
        `  ${branch} -> ${entry.upstreamPrUrl} (last sync ${formatDate(entry.lastSyncedAt)})`
    )
  );
  add(
    'Shipped issues',
    Object.values(links.shippedIssues).map(
      (entry) =>
        `  #${entry.internalIssueNumber} -> ${entry.upstreamIssueUrl} (${formatDate(entry.shippedAt)})`
    )
  );
  add(
    'Pulled issues',
    Object.values(links.pulledIssues).map(
      (entry) =>
        `  #${entry.internalIssueNumber} <- ${entry.upstreamIssueUrl} (${formatDate(entry.pulledAt)})`
    )
  );
  return blocks.join('\n\n');
}

/**
 * Doctor command: prints the health checks as a table, then the link maps
 * (or JSON `{ checks, links }` with `json`; `links` is null when the config
 * is unreadable). Returns false when any check failed so the caller can
 * exit 1.
 */
export async function doctorCommand(
  options: { json?: boolean; cwd?: string } = {}
): Promise<boolean> {
  const { checks, config } = await runDoctor({ cwd: options.cwd });
  const healthy = checks.every((check) => check.ok !== false);
  const links = config ? doctorLinks(config) : null;
  if (options.json) {
    console.log(JSON.stringify({ checks, links }, null, 2));
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
  const linkText = links ? formatLinks(links) : '';
  if (linkText) p.note(linkText, 'Links');
  p.outro(`${healthy ? '✨' : '❌'} ${doctorSummary(checks)}`);
  return healthy;
}

/**
 * One-line tally for the doctor outro. Says "All checks passed" only when
 * every check passed; otherwise counts failed, passed and skipped checks.
 */
export function doctorSummary(checks: DoctorCheck[]): string {
  const failed = checks.filter((check) => check.ok === false).length;
  const passed = checks.filter((check) => check.ok === true).length;
  const skipped = checks.length - failed - passed;
  if (failed === 0 && skipped === 0) return 'All checks passed';
  return [
    failed > 0 ? `${failed} failed` : '',
    `${passed} passed`,
    skipped > 0 ? `${skipped} skipped` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

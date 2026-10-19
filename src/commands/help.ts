import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';
import { stdoutUi, type Ui } from '../shared/ui.js';

const COMMAND_HELP: ReadonlyArray<readonly [string, string]> = [
  [
    'setup',
    `venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--own-upstream] [--yes] [--no-input] [--json]
  Create private mirror + public fork for vendor workflow
  <upstream>: GitHub HTTPS/SSH URL, or shorthand owner/repo (e.g. facebook/react)

  Options:
  • --org <name>       Create repos under organization instead of user account.
                       Your own username keeps the personal account with no confirm
  • --fork-name <name> Public fork repo name under owner (gh repo fork --fork-name).
                       Use when upstream is already owner/repo so the fork needs a different name.
  • --own-upstream     Skip the public fork hop entirely. Only origin + upstream are
                       configured; \`venfork stage\` later pushes branches directly to upstream.
                       Use when you own the upstream repo (no need to round-trip through a fork).
                       Mutually exclusive with --fork-name.
  • --yes, -y          Answer the personal-account confirm with yes
  • --no-input         Never prompt: [name] defaults to <repo>-private; a missing
                       <upstream> or an unconfirmed personal account exits 2
  • --json             Print one JSON envelope on stdout; implies --no-input

  Creates:
  • Private mirror (yourname/project-private) - internal work
  • Public fork (yourname/project) - staging for upstream (omitted with --own-upstream)
  • Configures remotes: origin, public, upstream (public omitted with --own-upstream)`,
  ],
  [
    'clone',
    `venfork clone <mirror> [--own-upstream] [--upstream <url>] [--public-fork <url>] [--yes] [--no-input] [--json]
  Clone an existing vendor setup and configure remotes automatically
  <mirror>: URL or owner/repo for the private mirror

  Reads the layout (public fork or not) and URLs from the mirror's venfork settings.
  For a mirror with no venfork settings (for example one not created by \`venfork setup\`), it detects them:
  • Public fork (strips -private suffix)
  • Upstream repository (from public fork's parent)
  • Configures three remotes (origin, public, upstream)

  Options (only when the mirror has no venfork settings):
  • --own-upstream     The mirror has no public fork (origin + upstream only)
  • --upstream <url>   Provide the upstream URL explicitly (skips auto-detect/prompt)
  • --public-fork <url> Provide the public fork URL or owner/repo (skips auto-detect/prompt);
                       not with --own-upstream
  • --no-input         Never prompt; a URL that would be asked for exits 2
  • --json             Print one JSON envelope on stdout; implies --no-input`,
  ],
  [
    '--version',
    `venfork --version
  Print the installed venfork version`,
  ],
  [
    'doctor',
    `venfork doctor [--yes] [--no-input] [--json]
  Check mirror health: remotes, venfork's sync commit, divergence,
  kept files, the sync workflow, the git transport (gh over HTTPS, or an SSH
  key GitHub accepts), the push secrets (VENFORK_PUSH_TOKEN, or the
  GitHub App secrets with schedule set --app) and the last scheduled run
  Also lists the shipped and pulled branch, PR and issue links venfork recorded
  Exits 1 when any check fails; --json prints the envelope with result
    { checks, links } (ok: true even when a check fails)`,
  ],
  [
    'sync',
    `venfork sync [--report-issues] [--yes] [--no-input] [--json]
  Update the default branches of origin (and public, unless the mirror has no public fork) to match upstream
  --report-issues (used by the scheduled workflow) opens a venfork-sync-blocked
    issue on the mirror when sync is blocked and closes it after a successful sync
  Keeps the private default branch at upstream plus one sync commit from venfork
    when the mirror has a schedule or kept files
  Applies the workflow allow and block lists (see venfork workflows)
  Syncs main/master branch without affecting your current work
  --json prints one JSON envelope on stdout, described at
    https://github.com/cabljac/venfork/blob/main/docs/reference/json.md`,
  ],
  [
    'schedule',
    `venfork schedule <status|set <cron> [--app|--token]|disable> [--yes] [--no-input] [--json]
  Manage scheduled sync for the mirror
  Set writes/removes ${SYNC_WORKFLOW_PATH} on the private mirror default branch
  --app mints a one-hour push token from a GitHub App on each run
    (secrets VENFORK_APP_CLIENT_ID and VENFORK_APP_PRIVATE_KEY)
  --token pushes with the VENFORK_PUSH_TOKEN secret (the default)
  Without either flag, set keeps the auth mode already configured
  --json prints the schedule after the action as one JSON envelope on stdout`,
  ],
  [
    'stage',
    `venfork stage <branch> [--no-pr] [--draft] [--dry-run] [--title <text>] [--base <branch>] [--internal-pr <n>] [--no-update-existing] [--yes] [--no-input] [--json]
venfork stage branch <name> [same options]
venfork stage issue <number-or-url> [--title <text>] [--yes] [--no-input] [--json]
  Push a branch (or an issue) from the mirror outward, to the public fork or upstream
  Branch names \`issue\` and \`branch\` need the explicit form: venfork stage branch issue
  Branch: push to public fork for PR to upstream
  Rebuilds the branch as linear history on upstream (merges and venfork's sync
    commit dropped, new SHAs) and refuses commits that carry mirror-only files or
    mention the mirror or venfork in their author, committer or message
  Then opens the upstream PR using the internal-review PR's body
    (with <!-- venfork:internal -->...<!-- /venfork:internal --> blocks redacted)
  Options:
  • --no-pr                Push the branch only; --draft, --title, --internal-pr and
                           --no-update-existing need the PR and are refused with it
  • --draft                Open the upstream PR as a draft
  • --dry-run              Show the commits, files and PR text that would be published;
                           push nothing. Needs no --yes; with --no-pr it uses no GitHub
                           API beyond the fetch
  • --internal-pr <n>      Pin a specific internal review PR number (skips most-recent-open lookup)
  • --no-update-existing   Do not update an already-open upstream PR body when staging
  • --yes, -y              Push (and open the PR or issue) without the confirm
  • --no-input             Never prompt; without --yes the confirm exits 2
  • --json                 Print one JSON envelope on stdout; implies --no-input
  Issue: read the internal mirror issue, strip venfork:internal blocks, open the
    upstream counterpart, record the link
  This is when your work becomes visible to the client`,
  ],
  [
    'pull',
    `venfork pull pr <pr-number-or-url> [--branch-name <name>] [--no-push] [--yes] [--no-input] [--json]
venfork pull issue <number-or-url> [--title <text>] [--yes] [--no-input] [--json]
  Bring upstream content into the private mirror
  • pr: fetch pull/<n>/head from upstream into a new branch (default: upstream-pr/<n>)
    and push it to origin so the team can review it. Run it again to refresh the branch
  • issue: read the upstream issue, open an internal triage issue on the mirror,
    record linkage. No comment sync; the linkage is one-shot.
    --yes opens it without the confirm; --no-input without --yes exits 2.
  --json prints one JSON envelope on stdout and implies --no-input`,
  ],
  [
    'workflows',
    `venfork workflows <status|allow|block|unallow|unblock|clear> [workflow-file ...] [--yes] [--no-input] [--json]
  Choose which upstream workflows run on the mirror (allowlist or blocklist)
  allow/block add files to their list; unallow/unblock remove them;
  clear empties both lists
  --json prints the policy after the action as one JSON envelope on stdout`,
  ],
  [
    'keep',
    `venfork keep <list|add|remove|clear> [path ...] [--yes] [--no-input] [--json]
  Carry mirror-only files (e.g. caller workflows) forward across \`venfork sync\`
  Each entry is a single repo-relative file (no globs, no directories), read from
  the previous origin tip on every sync
  Upstream wins on collision; missing source aborts sync until the file is committed
  \`venfork keep remove <path>\` also removes an invalid entry
  --json prints the list after the action as one JSON envelope on stdout`,
  ],
];

const SUBCOMMAND_HELP: ReadonlyArray<readonly [string, string]> = [
  [
    'pull pr',
    `venfork pull pr <pr-number-or-url> [--branch-name <name>] [--no-push] [--yes] [--no-input] [--json]
  Bring a third-party upstream PR into the mirror for internal review
  Fetches pull/<n>/head from upstream into a new branch (default: upstream-pr/<n>)
  Pushes the branch to origin so the team can see it
  Run it again to refresh the branch to the PR's current head
  --json prints one JSON envelope on stdout`,
  ],
  [
    'pull issue',
    `venfork pull issue <number-or-url> [--title <text>] [--yes] [--no-input] [--json]
  Read an upstream issue and open an internal triage issue on the mirror
  Records the link. No comment sync; the link is one-shot.
  --yes opens it without the confirm; --no-input without --yes exits 2
  --json prints one JSON envelope on stdout and implies --no-input`,
  ],
  [
    'stage issue',
    `venfork stage issue <number-or-url> [--title <text>] [--yes] [--no-input] [--json]
  Read an internal mirror issue, strip venfork:internal blocks,
  open the upstream counterpart, record the link
  --yes opens it without the confirm; --no-input without --yes exits 2
  --json prints one JSON envelope on stdout and implies --no-input`,
  ],
];

/**
 * Every help entry as the `command` and `rest` that select it in
 * `commandHelp`, commands first, then subcommands.
 */
export function helpTopics(): ReadonlyArray<
  readonly [string, readonly string[]]
> {
  return [
    ...COMMAND_HELP.map(([name]) => [name, []] as const),
    ...SUBCOMMAND_HELP.map(([name]) => {
      const [command, ...rest] = name.split(' ');
      return [command ?? name, rest] as const;
    }),
  ];
}

/**
 * Usage text for one command (`venfork <command> --help`), or null when
 * the command has no help entry. A known subcommand (`pull pr`,
 * `stage issue`) in `rest` selects its own entry.
 */
export function commandHelp(
  command: string,
  rest: string[] = []
): string | null {
  if (command.startsWith('-') && command !== '--version') return null;
  const sub = rest.find((arg) => !arg.startsWith('-'));
  if (sub) {
    const subHelp = SUBCOMMAND_HELP.find(
      ([name]) => name === `${command} ${sub}`
    );
    if (subHelp) return subHelp[1];
  }
  return COMMAND_HELP.find(([name]) => name === command)?.[1] ?? null;
}

const COMMAND_LIST = `Get started
  setup <owner/repo>           Create the mirror and public fork, clone it
  clone <mirror>               Join a mirror a teammate set up

Every day
  sync                         Bring upstream changes into the mirror
  stage <branch>               Publish a branch and open the upstream PR
  doctor                       Check the mirror, list what was published

Review upstream work
  pull pr <number-or-url>      Bring an upstream PR in for review
  pull issue <number-or-url>   Copy an upstream issue in for triage
  stage issue <number-or-url>  Publish an internal issue upstream

Automation
  schedule set <cron>          Sync on a schedule with GitHub Actions
  keep add <path>              Keep a mirror-only file across sync
  workflows block <file>       Stop an upstream workflow on the mirror

Advanced
  stage <branch> --dry-run     Show what stage would publish, push nothing
  --yes, --no-input            On every command: confirm, or never prompt
  --json                       Print one JSON result (not with help)

Example
  venfork setup acme/widget --org my-company && cd widget-private
  venfork stage fix-typo   # after you commit on a fix-typo branch`;

const HELP_TOPICS: ReadonlyArray<readonly [string, string]> = [
  [
    'env',
    `VENFORK_ORG - Default organization for repo creation
  Priority: --org, then VENFORK_ORG, then your personal account (after a prompt)
  Example: export VENFORK_ORG=my-company

VENFORK_NONINTERACTIVE=1 - Never prompt, as with --no-input (it does not
  confirm; pass --yes for that). venfork also never prompts when CI is set or
  without a terminal on stdin and stderr. A prompt that cannot be shown exits 2
  naming the flag to pass.

VENFORK_GIT_TIMEOUT - Cap in ms for each network git/gh operation
  (default 600000)

VENFORK_SEED_CHUNK - Commits per push when setup seeds a new mirror
  (default 1000)

VENFORK_SEED_RETRY_MS - Base backoff in ms between seed push retries
  (default 8000)

NO_COLOR - Print plain progress lines on stderr even in a terminal

GITHUB_REPOSITORY - Set by GitHub Actions. With --report-issues, sync files the
  venfork-sync-blocked issue there without a privacy lookup when it names origin

Advanced

VENFORK_ALLOW_SELF_REFERENCE=1 - Stop stage refusing the bare word venfork in
  commit messages, PR titles and bodies. The mirror URL, owner and repo name
  stay refused.`,
  ],
  [
    'exit-codes',
    `0    Success, or "no" at a confirm in a terminal
1    Runtime failure, a partial success, or doctor found a failing check
2    Usage error, or missing input or consent with no prompt
130  Cancelled at a prompt (or its input ended), interrupted by SIGINT,
     or the terminal closed
143  Terminated by SIGTERM`,
  ],
];

/**
 * Text of a `venfork help <topic>` page (`env`, `exit-codes`), or null when
 * `topic` is not one.
 */
export function helpTopic(topic: string): string | null {
  return HELP_TOPICS.find(([name]) => name === topic)?.[1] ?? null;
}

/**
 * Show the one-screen command list on `ui`: stdout when help was asked
 * for, stderr when it stands in for a usage error.
 */
export function showHelp(ui: Ui = stdoutUi): void {
  ui.intro('venfork - private mirrors for vendor work on public repos');
  ui.note(COMMAND_LIST, 'Commands');
  ui.outro(
    'More: venfork <command> --help, venfork help env, venfork help exit-codes'
  );
}

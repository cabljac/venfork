import * as p from '@clack/prompts';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';

const COMMAND_HELP: ReadonlyArray<readonly [string, string]> = [
  [
    'setup',
    `venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--no-public]
  Create private mirror + public fork for vendor workflow
  <upstream>: GitHub HTTPS/SSH URL, or shorthand owner/repo (e.g. facebook/react)

  Options:
  • --org <name>       Create repos under organization instead of user account
  • --fork-name <name> Public fork repo name under owner (gh repo fork --fork-name).
                       Use when upstream is already owner/repo so the fork needs a different name.
  • --no-public        Skip the public fork hop entirely. Only origin + upstream are
                       configured; \`venfork stage\` later pushes branches directly to upstream.
                       Use when you own the upstream repo (no need to round-trip through a fork).
                       Mutually exclusive with --fork-name.

  Creates:
  • Private mirror (yourname/project-private) - internal work
  • Public fork (yourname/project) - staging for upstream (omitted with --no-public)
  • Configures remotes: origin, public, upstream (public omitted with --no-public)`,
  ],
  [
    'clone',
    `venfork clone <vendor-repo> [--no-public] [--upstream <url>]
  Clone an existing vendor setup and configure remotes automatically
  <vendor-repo>: URL or owner/repo for the private mirror

  Reads layout (mode + URLs) from the venfork-config branch when present.
  Falls back to auto-detection when the branch is absent (legacy mirrors):
  • Public fork (strips -private suffix)
  • Upstream repository (from public fork's parent)
  • Configures three remotes (origin, public, upstream)

  Options (only meaningful when venfork-config is absent):
  • --no-public        Declare a no-public layout (origin + upstream only)
  • --upstream <url>   Provide the upstream URL explicitly (skips auto-detect/prompt)`,
  ],
  [
    '--version',
    `venfork --version
  Print the installed venfork version`,
  ],
  [
    'status',
    `venfork status [--check] [--json]
  Show current repository setup and configuration
  Check which remotes are configured and setup completion
  --check runs the same health checks as \`venfork doctor\``,
  ],
  [
    'doctor',
    `venfork doctor [--json]
  Check mirror health: remotes, the managed-commit invariant, divergence,
  preserved files, the sync workflow, VENFORK_PUSH_TOKEN and the last scheduled run
  Exits 1 when any check fails; --json prints machine-readable results for CI`,
  ],
  [
    'sync',
    `venfork sync [branch] [--report-issues]
  Update the default branches of origin (and public, unless --no-public) to match upstream
  --report-issues (used by the scheduled workflow) opens a venfork-sync-blocked
    issue on the mirror when sync is blocked and closes it after a successful sync
  Keeps the private default branch at upstream plus one venfork-managed commit
    when that commit carries the sync workflow or preserved files
  Applies workflow filtering from enabledWorkflows/disabledWorkflows policy
  Syncs main/master branch without affecting your current work`,
  ],
  [
    'schedule',
    `venfork schedule <status|set <cron>|disable>
  Manage scheduled sync config stored in venfork-config
  Set writes/removes ${SYNC_WORKFLOW_PATH} on the private mirror default branch`,
  ],
  [
    'stage',
    `venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>] [--internal-pr <n>] [--no-update-existing]
  Push branch to public fork for PR to upstream
  Rebuilds the branch as linear history on upstream (merges and venfork-managed
    commits dropped, new SHAs) and refuses commits that carry mirror-only files or
    mention the mirror or venfork in their author, committer or message
  With --pr, also opens the upstream PR using the internal-review PR's body
    (with <!-- venfork:internal -->...<!-- /venfork:internal --> blocks redacted)
  Options:
  • --internal-pr <n>      Pin a specific internal review PR number (skips most-recent-open lookup)
  • --no-update-existing   Do not update an already-open upstream PR body when staging
  This is when your work becomes visible to the client`,
  ],
  [
    'pull-request',
    `venfork pull-request <pr-number-or-url> [--branch-name <name>] [--no-push]
  Bring a third-party upstream PR into the mirror for internal review
  Fetches pull/<n>/head from upstream into a new branch (default: upstream-pr/<n>)
  Pushes the branch to origin so the team can see it
  Refresh later with: venfork sync <branch>`,
  ],
  [
    'issue',
    `venfork issue <stage|pull> <number-or-url> [--title <text>]
  Move issue context between the private mirror and upstream
  • stage: read internal mirror issue, strip venfork:internal blocks,
    open the upstream counterpart, record linkage in venfork-config
  • pull: read upstream issue, open an internal triage issue on the mirror,
    record linkage. No comment sync; the linkage is one-shot.`,
  ],
  [
    'workflows',
    `venfork workflows <status|allow|block|clear> [workflow-file ...]
  Configure workflow allowlist/blocklist policy in venfork-config`,
  ],
  [
    'preserve',
    `venfork preserve <list|add|remove|clear> [path ...]
  Carry mirror-only files (e.g. caller workflows) forward across \`venfork sync\`
  Each entry is a single repo-relative file (no globs, no directories), read from
  the previous origin tip on every sync
  Upstream wins on collision; missing source aborts sync until the file is committed
  \`venfork preserve remove <path>\` also removes an invalid entry`,
  ],
];

/**
 * Usage text for one command (`venfork <command> --help`), or null when
 * the command has no help entry.
 */
export function commandHelp(command: string): string | null {
  if (command.startsWith('-')) return null;
  return COMMAND_HELP.find(([name]) => name === command)?.[1] ?? null;
}

/**
 * Show help information
 */
export function showHelp(): void {
  p.intro('🔧 Venfork - Private Repository Mirrors for Vendor Development');

  p.note(
    COMMAND_HELP.map(([, text]) => text).join('\n\n'),
    'Available Commands'
  );

  p.note(
    `# One-time setup
venfork setup git@github.com:awesome/project.git
# or shorthand:
venfork setup awesome/project

# Or for organization repos:
venfork setup git@github.com:awesome/project.git --org my-company

# Same org as upstream: give the public fork a different repo name
venfork setup my-org/lib.git my-org-lib-private --org my-org --fork-name lib-public

cd project-private

# Work privately (juniors can learn here!)
git checkout -b feature/new-thing
# ... work, mistakes, learning, iteration ...
git push origin feature/new-thing
# Still private! Create internal PR for team review

# After team approval, stage for upstream and open the PR in one go
venfork stage feature/new-thing --pr
# NOW visible on public fork; upstream PR is opened with your internal review body

# Bring a third-party upstream PR in for internal review
venfork pull-request 1234
# Refresh as the contributor pushes updates: venfork sync upstream-pr/1234`,
    'Example Workflow'
  );

  p.note(
    `VENFORK_ORG - Default organization for repo creation
  Priority: --org flag, then VENFORK_ORG, then your personal account (after a prompt)
  Example: export VENFORK_ORG=my-company

VENFORK_NONINTERACTIVE=1 - Auto-confirm the prompts that allow it (not every prompt)

VENFORK_GIT_TIMEOUT - Cap in ms for each network git/gh operation (default 600000)

VENFORK_SEED_CHUNK - Commits per push when setup seeds a new mirror (default 1000)

VENFORK_SEED_RETRY_MS - Base backoff in ms between seed push retries (default 8000)

GITHUB_REPOSITORY - Set by GitHub Actions. With --report-issues, sync files the
  venfork-sync-blocked issue there without a privacy lookup when it names origin`,
    'Environment Variables'
  );

  p.outro('Built for teams who need private vendor workflows');
}

import * as p from '@clack/prompts';
import { SYNC_WORKFLOW_PATH } from '../shared/constants.js';

/**
 * Show help information
 */
export function showHelp(): void {
  p.intro('🔧 Venfork - Private Repository Mirrors for Vendor Development');

  p.note(
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
  • Configures remotes: origin, public, upstream (public omitted with --no-public)

venfork clone <vendor-repo> [--no-public] [--upstream <url>]
  Clone an existing vendor setup and configure remotes automatically
  <vendor-repo>: URL or owner/repo for the private mirror

  Reads layout (mode + URLs) from the venfork-config branch when present.
  Falls back to auto-detection when the branch is absent (legacy mirrors):
  • Public fork (strips -private suffix)
  • Upstream repository (from public fork's parent)
  • Configures three remotes (origin, public, upstream)

  Options (only meaningful when venfork-config is absent):
  • --no-public        Declare a no-public layout (origin + upstream only)
  • --upstream <url>   Provide the upstream URL explicitly (skips auto-detect/prompt)

venfork --version
  Print the installed venfork version

venfork status
  Show current repository setup and configuration
  Check which remotes are configured and setup completion

venfork sync [branch]
  Update default branches of origin and public to match upstream
  Re-stamps private default branch as upstream + one internal workflow commit when schedule is enabled
  Applies workflow filtering from enabledWorkflows/disabledWorkflows policy
  Syncs main/master branch without affecting your current work

venfork schedule <status|set <cron>|disable>
  Manage scheduled sync config stored in venfork-config
  Set writes/removes ${SYNC_WORKFLOW_PATH} on the private mirror default branch

venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>] [--internal-pr <n>] [--no-update-existing]
  Push branch to public fork for PR to upstream
  When the branch contains a venfork-managed commit, strips it before public push
  With --pr, also opens the upstream PR using the internal-review PR's body
    (with <!-- venfork:internal -->...<!-- /venfork:internal --> blocks redacted)
  Options:
  • --internal-pr <n>      Pin a specific internal review PR number (skips most-recent-open lookup)
  • --no-update-existing   Do not update an already-open upstream PR body when staging
  This is when your work becomes visible to the client

venfork pull-request <pr-number-or-url> [--branch-name <name>] [--no-push]
  Bring a third-party upstream PR into the mirror for internal review
  Fetches pull/<n>/head from upstream into a new branch (default: upstream-pr/<n>)
  Pushes the branch to origin so the team can see it
  Refresh later with: venfork sync <branch>

venfork issue <stage|pull> <number-or-url> [--title <text>]
  Move issue context between the private mirror and upstream
  • stage: read internal mirror issue, strip venfork:internal blocks,
    open the upstream counterpart, record linkage in venfork-config
  • pull: read upstream issue, open an internal triage issue on the mirror,
    record linkage. No comment sync — the linkage is one-shot.

venfork workflows <status|allow|block|clear> [workflow-file ...]
  Configure workflow allowlist/blocklist policy in venfork-config

venfork preserve <list|add|remove|clear> [path ...]
  Carry mirror-only files (e.g. caller workflows) forward across \`venfork sync\`
  Each entry is a repo-relative path read from the previous origin tip on every sync
  Upstream wins on collision; missing source aborts sync until the file is committed`,
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
  Set this to avoid typing --org every time

  Priority:
  1. --org flag (highest priority)
  2. VENFORK_ORG environment variable
  3. Personal account (with confirmation prompt)

  Example:
  export VENFORK_ORG=my-company
  venfork setup <url>  # Uses my-company automatically`,
    'Environment Variables'
  );

  p.outro('Built for teams who need private vendor workflows');
}

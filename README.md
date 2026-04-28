<p align="center">
  <img src="https://raw.githubusercontent.com/cabljac/venfork/refs/heads/main/assets/logo.svg" alt="Venfork Logo" width="200" />
</p>

# 🔧 Venfork

[![CI](https://github.com/cabljac/venfork/actions/workflows/ci.yml/badge.svg)](https://github.com/cabljac/venfork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Create and manage private mirrors of public GitHub repositories for vendor development workflows.

## What is Venfork?

Venfork helps contractors and vendors who need to work on private forks of public repositories. It creates a **three-repository workflow**:

1. **Private Mirror** (`yourname/project-private` or `org/project-private`) - Where your team works internally
2. **Public Fork** (`yourname/project` or `org/project`) - Staging area for contributions to upstream
3. **Upstream** (`original/project`) - The original repository

> **Note:** Repos can be created under your personal account or under an organization using the `--org` flag.

### Why Three Repositories?

**The Key Insight:**
> "The private mirror is completely disconnected from the public fork, allowing teams to experiment freely before presenting work to the client"

The private mirror is:
- ✅ Completely disconnected from the public fork
- ✅ Safe space to experiment, iterate, and refine work
- ✅ All internal PRs, reviews, and experiments stay private
- ✅ Only visible to your team

When you run `venfork stage`, your work becomes visible on the public fork and ready for PR to upstream.

## Prerequisites

Before using Venfork, ensure you have:

- **Node.js 18+** or **Bun** (for running the CLI)
- **GitHub CLI (`gh`)** installed and authenticated
  ```bash
  # Install gh (macOS)
  brew install gh

  # Authenticate
  gh auth login
  ```
- **Git** installed locally (used after clone for branches, remotes, and pushes)
- **Clone URLs:** Venfork uses **`gh repo clone`** for fetching repositories, so transport (SSH vs HTTPS) follows your GitHub CLI config (`gh config get git_protocol`). SSH keys or HTTPS credentials are still required for Git operations such as **`git push`**.

## Installation

```bash
# Install globally with npm
npm install -g venfork

# Or with Bun
bun install -g venfork

# Or use with npx (no installation needed)
npx venfork setup <repo-url>
```

## Quick Start

```bash
# 1a. One-time setup (first team member, personal account)
venfork setup git@github.com:awesome/project.git
# or: venfork setup awesome/project

# Or for organization repos
venfork setup git@github.com:awesome/project.git --org my-company

# The same setup command is safe to re-run when the GitHub repos already exist
# (see "Re-running setup" under venfork setup — repairs remotes, config, and syncs).

# 1b. Clone existing setup (other team members)
venfork clone git@github.com:yourname/project-private.git

cd project-private

# 2. Work privately
git checkout -b feature/new-thing
# ... experiment, iterate, refine ...
git push origin feature/new-thing
# Still private! Create internal PR for team review

# 3. Stage for upstream (after internal approval)
venfork stage feature/new-thing --pr
# NOW visible on public fork — and the upstream PR is opened for you,
# carrying your internal review body (with <!-- venfork:internal --> blocks redacted).

# Or just stage and open the PR yourself later:
venfork stage feature/new-thing
```

```bash
# Reviewing a third-party upstream PR internally
venfork pull-request 1234
# upstream-pr/1234 now exists on the mirror; team can review/test against your internal codebase

# Refresh as the upstream contributor pushes updates
venfork sync upstream-pr/1234
```

## Commands

### `venfork setup <upstream> [name] [--org <organization>] [--fork-name <repo>]`

Creates the complete vendor workflow setup:

**`<upstream>`** may be a full GitHub clone URL (SSH or HTTPS) or **shorthand** `owner/repo` (e.g. `invertase/react-native-firebase`), which is treated like `git@github.com:owner/repo.git`.

**`--fork-name`** sets the **public fork’s repository name** under your chosen owner/org (passed through to `gh repo fork --fork-name`). Use this when **upstream already lives under the same org** you pass to `--org`: GitHub cannot create a second repo with the same name, so the fork must use a different name (e.g. `my-lib-public` while upstream is `my-lib`).

**What it creates:**
- **Private mirror** (`yourname/project-private` or `org/project-private`) - For internal work
- **Public fork** (`yourname/project` or `org/project`, or the name from **`--fork-name`**) - For staging to upstream
- **Config branch** (`venfork-config`) - Stores remote URLs for easy team cloning
- **Local clone** with three remotes configured:
  - `origin` → private mirror (default push/pull)
  - `public` → public fork (for staging)
  - `upstream` → original repo (read-only, push disabled)

**Arguments:**
- `upstream` - GitHub repository URL (SSH or HTTPS), or shorthand `owner/repo`
- `name` - (Optional) Name for private mirror repo (default: `{repo}-private`)
- `--org <organization>` - (Optional) Create repos under organization instead of personal account
- `--fork-name <repo>` - (Optional) Public fork repo name under that org/user (default: same basename as upstream)

**Examples:**
```bash
# Personal account (default)
venfork setup git@github.com:vercel/next.js.git
# Shorthand (same as git@github.com:vercel/next.js.git)
venfork setup vercel/next.js
# Creates: yourname/next.js-private (private), yourname/next.js (public fork)

venfork setup https://github.com/vuejs/vue.git vue-internal
# Creates: yourname/vue-internal (private), yourname/vue (public fork)

# Organization account
venfork setup git@github.com:client/awesome-project.git --org acme-corp
# Creates: acme-corp/awesome-project-private (private), acme-corp/awesome-project (public fork)

venfork setup git@github.com:client/project.git internal-mirror --org my-company
# Creates: my-company/internal-mirror (private), my-company/project (public fork)

# Upstream is already my-org/foo — fork under my-org with a different public repo name
venfork setup my-org/foo my-foo-private --org my-org --fork-name foo-public
# Creates: my-org/my-foo-private (private), my-org/foo-public (public fork), upstream = my-org/foo

# Shorthand also works with --org + --fork-name (equivalent to git@github.com:firebase/extensions.git)
venfork setup firebase/extensions firebase-extensions-private --org invertase --fork-name firebase-extensions
```

**Re-running setup (repos already on GitHub):** Run the same command again if you need a fresh local clone, remote fixes, or an updated `venfork-config` branch. Venfork uses `gh repo view` to detect a public fork or private mirror that already exists when `gh repo fork` or `gh repo create` fails, then:

- Skips seeding a **new** private mirror from upstream (no duplicate initial push).
- Clones the private mirror into `./<private-mirror-name>`, or **reuses** that directory if it is already a git repo whose `origin` points at the expected mirror URL.
- Ensures `public` and `upstream` remotes exist and point at the right URLs (adds or corrects them).
- Pushes the `venfork-config` branch again so teammates get current URLs.
- If **either** GitHub repo was already present, runs **`venfork sync` inside that clone** so defaults are normalized from `upstream` (subject to divergence safeguards): `public` matches upstream, while `origin` may include one managed workflow commit when scheduled sync is enabled.

Pure failures (for example name taken by a **different** repo) still abort setup. If recovery sync stops due to divergent default branches, fix or move those commits, then run **`venfork sync`** again from inside the private mirror.

### `venfork clone <vendor-repo>`

Clone an existing vendor setup and automatically configure all remotes.

**`<vendor-repo>`** is the private mirror: full GitHub URL or shorthand `owner/repo`.

**What it does:**
- Clones the private mirror repository
- **Reads venfork-config branch** for public fork and upstream URLs (if available)
- Falls back to auto-detection:
  - Public fork (by stripping `-private` suffix)
  - Upstream repository (from public fork's parent)
- Configures all three remotes (origin, public, upstream)
- Disables push to upstream (read-only)

**Use this when:**
- A teammate has already run `venfork setup`
- You need to clone an existing vendor setup
- You want automatic remote configuration

**Arguments:**
- `vendor-repo` - GitHub URL or `owner/repo` of the private vendor repository

**Examples:**
```bash
# Clone existing vendor setup (personal account)
venfork clone git@github.com:yourname/project-private.git
venfork clone yourname/project-private
# Reads config from venfork-config branch (if available)
# Or auto-detects: public fork at yourname/project

# Clone organization vendor setup
venfork clone git@github.com:acme-corp/awesome-project-private.git
# Reads config from venfork-config branch (if available)
# Or auto-detects: public fork at acme-corp/awesome-project
```

**Interactive prompts:**
- If public fork cannot be auto-detected, you'll be prompted for the URL
- If upstream cannot be auto-detected (no parent), you'll be prompted for the URL

### `venfork sync [branch]`

Update default branches from upstream. With scheduled sync enabled, the private mirror uses a managed `+1` model:
- `public/<default>` matches `upstream/<default>`
- `origin/<default>` is `upstream/<default>` plus one deterministic managed workflow commit

Normally you run this from your private mirror directory (or any subfolder of that repo). The same behavior is also used internally when **`venfork setup`** completes in recovery mode (existing GitHub repos), using the new clone’s path automatically.

**Arguments:**
- `branch` - (Optional) Upstream branch to sync (default: auto-detected, usually `main` or `master`)

**Examples:**
```bash
venfork sync           # Sync default branches with upstream
venfork sync develop   # Sync develop branch with upstream/develop
```

**What it does:**
1. Fetches latest changes from all remotes (upstream, origin, public)
2. Checks for divergent commits (warns if found to prevent data loss)
3. Pushes upstream's default branch to origin and public
4. If scheduled sync is enabled, re-applies one deterministic top commit for `.github/workflows/venfork-sync.yml` on the private mirror default branch
5. If workflow policy is configured, that managed commit filters `.github/workflows` using:
   - `enabledWorkflows` allowlist (highest precedence)
   - otherwise `disabledWorkflows` blocklist
6. **Does not affect your current working branch or feature branches**

**Important:**
- With scheduled sync enabled, mirror default branch follows the `upstream + 1 managed commit` model
- Public default branch remains aligned with upstream
- Your current work on feature branches is completely unaffected
- If divergent commits are detected, sync will abort to prevent data loss

### `venfork status`

Check the current repository setup and configuration.

**What it shows:**
- Current branch
- All configured git remotes (fetch and push URLs)
- Setup completion status (✓/✗ for origin, public, upstream)
- Next steps if setup is incomplete

**Examples:**
```bash
venfork status
```

**Use this command to:**
- Verify your venfork setup is complete
- Debug remote configuration issues
- Check which remotes are configured
- See your current branch

### `venfork stage <branch> [--pr] [--draft] [--title <text>] [--base <branch>]`

Push a branch to the public fork, making it visible and ready for PR to upstream. With `--pr`, also opens the upstream PR for you using your internal review PR's body.

**⚠️ Important:** This is when your work becomes visible to the client!

**Arguments:**
- `branch` - Branch name to stage

**Flags:**
- `--pr` - Also open an upstream PR after staging. Looks up your internal-review PR on the private mirror and copies its description (with redacted blocks stripped — see below) into the upstream PR.
- `--draft` - Open the upstream PR as a draft. Implies `--pr`.
- `--title <text>` - Override the upstream PR title (default: the internal PR title, or the branch name if no internal PR was found).
- `--base <branch>` - Override the upstream base branch (default: upstream's default branch).

**Examples:**
```bash
# Stage only — same as before
venfork stage feature-auth

# Stage and open the upstream PR using the internal review body
venfork stage feature-auth --pr

# Open as draft
venfork stage feature-auth --draft

# Override title or base
venfork stage feature-auth --pr --title "Add OAuth"
venfork stage feature-auth --pr --base develop
```

**What it does (without `--pr`):**
1. Verifies branch exists
2. Shows staging details and confirmation
3. Rebuilds branch history on top of upstream while removing internal workflow commits
4. Pushes sanitized history to public fork
5. Provides a compare URL so you can open the PR yourself

**What `--pr` adds:**
1. Looks up the most recent PR on the private mirror with `--head <branch>` (open first, then most recent of any state).
2. Renders the upstream PR body by stripping any `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks and appending a footer linking back to the internal review.
3. Shows you the translated body **before** confirming, so you can catch redaction mistakes before they go public.
4. Runs `gh pr create --repo <upstream> --base <default> --head <fork-owner>:<branch>` and surfaces the resulting PR URL.
5. Records the linkage in `venfork-config.shippedBranches[<branch>]` for later tracking.

**Redacting internal-only context**

In the body of your internal review PR, wrap anything that should NOT go upstream in HTML comments:

```md
This PR adds OAuth login.

<!-- venfork:internal -->
Internal note: Client X explicitly asked us to use Auth0 instead of Keycloak (see ticket INT-1234).
<!-- /venfork:internal -->

The implementation follows the spec at https://example.com/oauth.
```

`venfork stage --pr` strips everything between the markers (greedy multi-line) before posting upstream. The upstream PR shows only the public summary; the internal context stays inside the redacted block on the private mirror, where only your team can see it.

If you forget to add markers, the entire internal body is sent upstream — review the preview prompt before confirming.

### `venfork pull-request <pr-number-or-url> [--branch-name <override>] [--no-push]`

Pull a third-party upstream PR into the private mirror so your team can review it internally before it lands. The PR's commits land on a new branch (`upstream-pr/<n>` by default) that's pushed to your mirror.

**Arguments:**
- `pr-number-or-url` - Either a bare integer (`1234`) or a github.com PR URL.

**Flags:**
- `--branch-name <name>` - Use a custom local/mirror branch name instead of `upstream-pr/<n>`.
- `--no-push` - Fetch into a local branch only; don't push to the mirror.

**Examples:**
```bash
# Bring upstream PR #1234 into the mirror
venfork pull-request 1234

# Or via URL
venfork pull-request https://github.com/upstream/repo/pull/1234

# Use a custom branch name (e.g. for staged team review of a critical PR)
venfork pull-request 1234 --branch-name review/oauth-pr
```

**What it does:**
1. Reads the upstream PR's metadata (`gh pr view`) and prints a summary (title, author, state, base, body preview, link).
2. Fetches `pull/<n>/head` from the upstream remote into a local branch.
3. Pushes that branch to `origin` (the private mirror) so the team can see it.
4. Records a `pulledPrs[<branch>]` entry in `venfork-config` so `venfork sync <branch>` knows which upstream PR to refresh from.

**Refreshing a pulled PR**

When the upstream contributor updates their PR, refresh your local + mirror copy with:

```bash
venfork sync upstream-pr/1234
```

`venfork sync <branch>` falls into the pulled-PR path when:
- `venfork-config.pulledPrs[<branch>]` exists (recorded by `pull-request`), OR
- The branch matches the `upstream-pr/<n>` naming convention.

In that case it refetches `pull/<n>/head` from upstream and force-with-lease pushes the result to origin. The default-branch sync (the +1-managed-commit flow) is unaffected.

### `venfork issue <stage|pull> <number-or-url> [--title <text>]`

Move *issue* context between the private mirror and upstream — the same shape as `stage --pr` and `pull-request`, but for issues instead of PRs.

**Sub-commands:**
- `stage <internal-#>` — read an internal triage issue from the mirror, redact `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks (same convention as `stage --pr`), and open the upstream counterpart via `gh issue create`.
- `pull <upstream-#>` — read an upstream issue, create a parallel internal issue on the mirror titled `[upstream #N] <original title>` so the team can triage it without leaving the private space.

**Flags:**
- `--title <text>` - Override the destination issue's title.

**Examples:**
```bash
# Found a bug while working internally → refine then file upstream
venfork issue stage 7

# Watching an upstream issue that affects the team's roadmap
venfork issue pull 1234
```

**What gets recorded**

Both sub-commands write a linkage to `venfork-config`:
- `shippedIssues[<internal-#>]` for `stage`
- `pulledIssues[<internal-#>]` for `pull`

This is **only the linkage** — comments and state changes do *not* sync. If the upstream issue is closed, the internal one stays open until you close it manually (and vice versa). Treat the records as a "where did this go?" audit log rather than a live mirror.

### `venfork schedule <status|set <cron>|disable>`

Manage automated sync configuration stored in `venfork-config`.

**Examples:**
```bash
venfork schedule status
venfork schedule set "0 */6 * * *"
venfork schedule disable
```

**What it does:**
1. Stores schedule state (`enabled`, `cron`) in `.venfork/config.json` on `venfork-config`
2. `set` writes/updates `.github/workflows/venfork-sync.yml` on the private mirror default branch
3. `disable` removes the managed workflow file from that branch

**Authenticating cross-repo pushes**

A scheduled run pushes to two different repos: the private mirror (`origin`) and the public fork (`public`). The default `GITHUB_TOKEN` available inside the workflow is scoped only to the mirror, so it cannot authenticate the push to the public fork. To enable the workflow to push cross-repo, set a `VENFORK_PUSH_TOKEN` secret on the **private mirror** repo using a token that has `contents:write` on both the mirror and the public fork:

```bash
gh secret set VENFORK_PUSH_TOKEN --repo <owner>/<mirror> --body "$(gh auth token)"
```

A fine-grained PAT scoped to just those two repos is also fine. If `VENFORK_PUSH_TOKEN` is unset, the generated workflow falls back to the default `GITHUB_TOKEN` — sync to the public fork will fail in that case (same behavior as before this token was wired in).

### `venfork workflows <status|allow|block|clear> [workflow-file ...]`

Manage which upstream workflow files should remain active in the private mirror when managed sync commit logic runs.

**Examples:**
```bash
venfork workflows status
venfork workflows allow ci.yml lint.yml
venfork workflows block deploy.yml e2e.yml
venfork workflows clear
```

**What it does:**
1. Stores `enabledWorkflows` / `disabledWorkflows` in `.venfork/config.json` on `venfork-config`
2. `allow` sets the allowlist by workflow filename
3. `block` sets the blocklist by workflow filename
4. `clear` removes both lists
5. Precedence: if `enabledWorkflows` is non-empty, it is used and `disabledWorkflows` is ignored
6. Changes apply to the mirror default branch on next `venfork sync` (when schedule is enabled)

## Environment Variables

### `VENFORK_ORG`

Set a default organization for all venfork commands. This avoids having to type `--org` every time.

**Priority order:**
1. `--org` flag (highest priority - always overrides)
2. `VENFORK_ORG` environment variable
3. Personal account (prompts for confirmation)

**Usage:**

```bash
# Set in your shell profile (~/.zshrc, ~/.bashrc, etc.)
export VENFORK_ORG=my-company

# Now all commands use this org by default
venfork setup git@github.com:client/project.git
# Creates: my-company/project-vendor (private), my-company/project (public fork)

# Override with --org flag when needed
venfork setup git@github.com:other-client/app.git --org different-org
# Creates: different-org/app-vendor (private), different-org/app (public fork)
```

**Safety feature:**
If neither `--org` nor `VENFORK_ORG` is set, venfork will prompt for confirmation before creating repos under your personal account. This prevents accidental personal repo creation when working as a vendor/contractor.

```bash
# Without VENFORK_ORG or --org
venfork setup git@github.com:client/project.git

# Output:
# ⚠️  No organization specified
# Repos will be created under your personal account (username: yourname)
# Continue with personal account? (y/N)
```

## Complete Workflow

### Initial Setup

```bash
# Clone and configure the repos (personal account)
venfork setup git@github.com:client/awesome-project.git

# Or for organization
venfork setup git@github.com:client/awesome-project.git --org acme-corp

# Navigate to private mirror
cd awesome-project-private

# Check setup status
venfork status

# Or verify remotes manually
git remote -v
# With personal account:
# origin    git@github.com:you/awesome-project-private.git (private)
# public    git@github.com:you/awesome-project.git (public fork)
# upstream  git@github.com:client/awesome-project.git (read-only)

# With organization:
# origin    git@github.com:acme-corp/awesome-project-private.git (private)
# public    git@github.com:acme-corp/awesome-project.git (public fork)
# upstream  git@github.com:client/awesome-project.git (read-only)
```

### Daily Development

```bash
# Sync default branches with upstream (optional, keeps main up-to-date)
venfork sync

# Create feature branch
git checkout -b feature/user-auth

# Make changes, commit
git add .
git commit -m "Add user authentication"

# Push to private mirror
git push origin feature/user-auth

# Create PR in private repo for team review
# Review happens internally, invisible to client
```

### Internal Review Process

```bash
# Team reviews PR in private repo
# Experiment, iterate, refine approach
# All feedback and changes stay private

# Once approved internally, merge to main
git checkout main
git merge feature/user-auth
git push origin main
```

### Staging for Upstream

```bash
# When ready to contribute back
venfork stage feature/user-auth

# Output shows:
# ✓ Branch staged to public fork
# 🔗 Create PR: https://github.com/client/awesome-project/compare/...

# NOW visible to client
# Create PR from public fork → upstream
```

## Repository Structure

```
┌─────────────────────────────────────────────┐
│  Upstream (client/project)                  │
│  • Original repository                      │
│  • Read-only for you                        │
└──────────────────┬──────────────────────────┘
                   │
                   │ fork
                   ▼
┌─────────────────────────────────────────────┐
│  Public Fork (you/project or org/project)   │
│  • Visible to everyone                      │
│  • Staging area for PRs                     │
│  • Only pushed to via `venfork stage`       │
└──────────────────┬──────────────────────────┘
                   │
                   │ mirror (disconnected)
                   ▼
┌─────────────────────────────────────────────┐
│  Private Mirror (you/project-private)       │
│                  (or org/project-private)   │
│  • Only visible to your team                │
│  • Safe space to experiment & iterate       │
│  • Internal PRs and reviews                 │
│  • Your daily work happens here             │
│  • Contains venfork-config branch           │
└─────────────────────────────────────────────┘
```

## Configuration

### Git Remotes

After `venfork setup`, your local repository has three remotes:

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `you/project-private` (or `org/project-private`) | Private work (default) |
| `public` | `you/project` (or `org/project`) | Stage for upstream |
| `upstream` | `original/project` | Sync with latest |

**Note:** When using `--org`, all repos are created under the specified organization.

### Default Behavior

- `git push` → Pushes to `origin` (private mirror)
- `git pull` → Pulls from `origin` (private mirror)
- `venfork sync` → Updates default branches of `origin` and `public` to match `upstream`
- `venfork stage` → Pushes to `public`

## Troubleshooting

### Check Your Setup

If you encounter issues, run `venfork status` first to check:
- Whether you're in a git repository
- Which remotes are configured
- If setup is complete

### "GitHub CLI is not authenticated"

Run `gh auth login` and follow the prompts to authenticate.

### "Not in a git repository"

Make sure you're inside the cloned vendor repository directory. Run `venfork status` to verify.

### "Remote not found" (origin/public/upstream)

This usually means setup never finished for this clone, or the clone is not the private mirror.
- Run `venfork status` to see which remotes are missing
- Re-run **`venfork setup <same-upstream-url>`** from an empty parent directory (or a directory where the private mirror folder doesn’t conflict) so remotes and config can be repaired, or use **`venfork clone`** on the private mirror URL instead

### Divergent Commits Warning

If `venfork sync` detects commits on your default branch that aren't in upstream:
1. This suggests work was committed directly to main/master (not recommended)
2. Sync will abort to prevent losing these commits
3. To preserve: manually rebase or cherry-pick them to a feature branch
4. To force sync anyway: `git push origin upstream/main:main -f` (loses commits)

### Branch Already Exists on Public Fork

If you've staged a branch before and need to update it:

```bash
git push public feature-branch --force
```

## Development

```bash
# Install dependencies (npm or bun)
npm install
# or
bun install

# Run tests
npm test
# or
bun test

# Run tests in watch mode
npm run test:watch
# or
bun run test:watch

# Run tests with coverage
npm run test:coverage
# or
bun run test:coverage

# Run in development mode
npm run dev setup --help
# or
bun run dev setup --help

# Build
npm run build
# or
bun run build

# Link for local testing
npm link
# or
bun link

# Format code
npm run format

# Lint code
npm run lint

# Check and fix all issues
npm run check
```

## Tech Stack

- **Runtime:** Node.js 18+ (or Bun for faster development)
- **Language:** TypeScript (strict mode)
- **Shell Execution:** execa
- **CLI Framework:** @clack/prompts
- **Code Quality:** Biome

## License

MIT

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) to get started.

Key steps:
1. Fork and clone the repository
2. Install dependencies: `bun install`
3. Make your changes and add tests
4. Run checks: `bun run check && bun test`
5. Use a conventional commit prefix (`feat:`, `fix:`, etc.) — release-please picks up the version bump from your commit message
6. Submit a pull request

## Support

If you encounter any issues or have questions:

1. Ensure you have the latest version installed
2. Open an issue on GitHub
---

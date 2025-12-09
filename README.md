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
- **Git** configured with SSH keys for GitHub

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

# Or for organization repos
venfork setup git@github.com:awesome/project.git --org my-company

# 1b. Clone existing setup (other team members)
venfork clone git@github.com:yourname/project-private.git

cd project-private

# 2. Work privately
git checkout -b feature/new-thing
# ... experiment, iterate, refine ...
git push origin feature/new-thing
# Still private! Create internal PR for team review

# 3. Stage for upstream (after internal approval)
venfork stage feature/new-thing
# NOW visible on public fork
# Create PR: public fork → upstream
```

## Commands

### `venfork setup <upstream-url> [name] [--org <organization>]`

Creates the complete vendor workflow setup:

**What it creates:**
- **Private mirror** (`yourname/project-private` or `org/project-private`) - For internal work
- **Public fork** (`yourname/project` or `org/project`) - For staging to upstream
- **Config branch** (`venfork-config`) - Stores remote URLs for easy team cloning
- **Local clone** with three remotes configured:
  - `origin` → private mirror (default push/pull)
  - `public` → public fork (for staging)
  - `upstream` → original repo (read-only, push disabled)

**Arguments:**
- `upstream-url` - GitHub repository URL (SSH or HTTPS)
- `name` - (Optional) Name for private mirror repo (default: `{repo}-private`)
- `--org <organization>` - (Optional) Create repos under organization instead of personal account

**Examples:**
```bash
# Personal account (default)
venfork setup git@github.com:vercel/next.js.git
# Creates: yourname/next.js-private (private), yourname/next.js (public fork)

venfork setup https://github.com/vuejs/vue.git vue-internal
# Creates: yourname/vue-internal (private), yourname/vue (public fork)

# Organization account
venfork setup git@github.com:client/awesome-project.git --org acme-corp
# Creates: acme-corp/awesome-project-private (private), acme-corp/awesome-project (public fork)

venfork setup git@github.com:client/project.git internal-mirror --org my-company
# Creates: my-company/internal-mirror (private), my-company/project (public fork)
```

### `venfork clone <vendor-repo-url>`

Clone an existing vendor setup and automatically configure all remotes.

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
- `vendor-repo-url` - GitHub URL of the private vendor repository (SSH or HTTPS)

**Examples:**
```bash
# Clone existing vendor setup (personal account)
venfork clone git@github.com:yourname/project-private.git
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

Update the default branches of your private mirror and public fork to match upstream.

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
3. Force pushes upstream's default branch to origin and public
4. **Does not affect your current working branch or feature branches**

**Important:**
- This keeps your default branches (main/master) in sync with upstream
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

### `venfork stage <branch>`

Push a branch to the public fork, making it visible and ready for PR to upstream.

**⚠️ Important:** This is when your work becomes visible to the client!

**Arguments:**
- `branch` - Branch name to stage

**Examples:**
```bash
venfork stage feature-auth
venfork stage bugfix/issue-123
```

**What it does:**
1. Verifies branch exists
2. Shows staging details and confirmation
3. Pushes to public fork
4. Provides PR creation link

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

This means `venfork setup` wasn't run or didn't complete successfully.
- Run `venfork status` to see which remotes are missing
- Re-run `venfork setup` if needed

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
5. Add a changeset: `bun run changeset`
6. Submit a pull request

## Support

If you encounter any issues or have questions:

1. Ensure you have the latest version installed
2. Open an issue on GitHub
---

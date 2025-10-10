# 🔧 Venfork

[![CI](https://github.com/cabljac/venfork/actions/workflows/ci.yml/badge.svg)](https://github.com/cabljac/venfork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Create and manage private mirrors of public GitHub repositories for vendor development workflows.

## What is Venfork?

Venfork helps contractors and vendors who need to work on private forks of public repositories. It creates a **three-repository workflow**:

1. **Private Mirror** (`yourname/project-vendor`) - Where your team works internally
2. **Public Fork** (`yourname/project`) - Staging area for contributions to upstream
3. **Upstream** (`original/project`) - The original repository

### Why Three Repositories?

**The Key Insight:**
> "Because the private fork is not attached to the public repo, our juniors can work on it and learn there without being seen by our client"

The private mirror is:
- ✅ Completely disconnected from the public fork
- ✅ Safe for junior devs to learn, make mistakes, iterate
- ✅ All internal PRs, reviews, experiments stay private
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
# 1. One-time setup
venfork setup git@github.com:awesome/project.git

cd project-vendor

# 2. Work privately
git checkout -b feature/new-thing
# ... make changes, learn, iterate ...
git push origin feature/new-thing
# Still private! Create internal PR for team review

# 3. Stage for upstream (after internal approval)
venfork stage feature/new-thing
# NOW visible on public fork
# Create PR: public fork → upstream
```

## Commands

### `venfork setup <upstream-url> [name]`

Creates the complete vendor workflow setup:

**What it creates:**
- **Private mirror** (`yourname/project-vendor`) - For internal work
- **Public fork** (`yourname/project`) - For staging to upstream
- **Local clone** with three remotes configured:
  - `origin` → private mirror (default push/pull)
  - `public` → public fork (for staging)
  - `upstream` → original repo (read-only, push disabled)

**Arguments:**
- `upstream-url` - GitHub repository URL (SSH or HTTPS)
- `name` - (Optional) Name for private vendor repo (default: `{repo}-vendor`)

**Examples:**
```bash
venfork setup git@github.com:vercel/next.js.git
# Creates: next.js-vendor (private), next.js (public fork)

venfork setup https://github.com/vuejs/vue.git vue-internal
# Creates: vue-internal (private), vue (public fork)
```

### `venfork sync [branch]`

Fetch from upstream and rebase current branch to stay up-to-date.

**Arguments:**
- `branch` - (Optional) Upstream branch to sync with (default: `main`)

**Examples:**
```bash
venfork sync           # Sync with upstream/main
venfork sync develop   # Sync with upstream/develop
```

**What it does:**
1. Fetches latest changes from upstream
2. Rebases your current branch on upstream
3. Handles conflicts gracefully with instructions

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

## Complete Workflow

### Initial Setup

```bash
# Clone and configure the repos
venfork setup git@github.com:client/awesome-project.git

# Navigate to private mirror
cd awesome-project-vendor

# Check setup status
venfork status

# Or verify remotes manually
git remote -v
# origin    git@github.com:you/awesome-project-vendor.git (private)
# public    git@github.com:you/awesome-project.git (public fork)
# upstream  git@github.com:client/awesome-project.git (read-only)
```

### Daily Development

```bash
# Sync with upstream before starting
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
# Junior devs iterate, learn, make mistakes
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
│  Public Fork (you/project)                  │
│  • Visible to everyone                      │
│  • Staging area for PRs                     │
│  • Only pushed to via `venfork stage`       │
└──────────────────┬──────────────────────────┘
                   │
                   │ mirror (disconnected)
                   ▼
┌─────────────────────────────────────────────┐
│  Private Mirror (you/project-vendor)        │
│  • Only visible to your team                │
│  • Where juniors learn & iterate            │
│  • Internal PRs and reviews                 │
│  • Your daily work happens here             │
└─────────────────────────────────────────────┘
```

## Configuration

### Git Remotes

After `venfork setup`, your local repository has three remotes:

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `you/project-vendor` | Private work (default) |
| `public` | `you/project` | Stage for upstream |
| `upstream` | `original/project` | Sync with latest |

### Default Behavior

- `git push` → Pushes to `origin` (private mirror)
- `git pull` → Pulls from `origin` (private mirror)
- `venfork sync` → Fetches from `upstream`
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

### Rebase Conflicts

When `venfork sync` encounters conflicts:
1. Open the conflicted files and resolve markers
2. Stage the resolved files: `git add <file>`
3. Continue: `git rebase --continue`
4. Or abort: `git rebase --abort`

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
1. Check the [Troubleshooting](#troubleshooting) section
2. Open an issue on GitHub
3. Ensure you have the latest version installed

---

Built with ❤️ for teams who need private vendor workflows

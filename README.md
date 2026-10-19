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

- **Node.js 22+** or **Bun** (for running the CLI)
- **GitHub CLI (`gh`)** installed and authenticated
  ```bash
  # Install gh (macOS)
  brew install gh

  # Authenticate
  gh auth login
  ```
- **Git** installed locally (used after clone for branches, remotes, and pushes)
- **Clone URLs:** Venfork uses **`gh repo clone`** for fetching repositories, so transport (SSH vs HTTPS) follows your GitHub CLI config (`gh config get git_protocol`). Over HTTPS, the git fetches and pushes that venfork runs use your gh login, so you need no other credential. Over SSH you need an SSH key that GitHub accepts. Your own `git push` outside venfork uses your git credentials as usual (run `gh auth setup-git` to let it use gh too). See [Headless and CI use](https://github.com/cabljac/venfork/blob/main/docs/reference/headless.md#headless-and-ci-use).

## Installation

```bash
# Install globally with npm
npm install -g venfork

# Or with Bun
bun install -g venfork

# Or use with npx (no installation needed)
npx venfork setup <repo-url>
```

The npm package bundles its libraries, so it installs no other packages.

## Quick Start

```bash
# 1a. One-time setup (first team member, personal account)
venfork setup git@github.com:awesome/project.git
# or: venfork setup awesome/project

# Or for organization repos
venfork setup git@github.com:awesome/project.git --org my-company

# The same setup command is safe to re-run when the GitHub repos already exist
# (see "Re-running setup" in docs/reference/commands.md: it repairs remotes, config, and syncs).

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
# NOW visible on public fork - and the upstream PR is opened for you,
# carrying your internal review body (with <!-- venfork:internal --> blocks redacted).

# Or push only and open the PR yourself later:
venfork stage feature/new-thing --no-pr
```

```bash
# Reviewing a third-party upstream PR internally
venfork pull pr 1234
# upstream-pr/1234 now exists on the mirror; team can review/test against your internal codebase

# Refresh as the upstream contributor pushes updates
venfork pull pr 1234
```

## Commands

| Command | What it does |
|---|---|
| `venfork setup <owner/repo> [--org <org>]` | Create the private mirror and public fork, then clone the mirror |
| `venfork clone <mirror>` | Join a mirror a teammate set up |
| `venfork sync` | Bring upstream changes into the mirror |
| `venfork stage <branch> [--draft] [--dry-run]` | Publish a branch and open the upstream PR (`--no-pr` pushes only) |
| `venfork doctor` | Check the mirror and list what was published |
| `venfork pull pr <n>` | Bring an upstream PR in for internal review; run it again to refresh |
| `venfork pull issue <n>` / `venfork stage issue <n>` | Copy an issue in from upstream, or publish an internal one |
| `venfork schedule set <cron>` | Sync on a schedule with GitHub Actions |
| `venfork keep add <path>` | Keep a mirror-only file across sync |
| `venfork workflows block <file>` | Stop an upstream workflow from running on the mirror |
| `venfork stage approval on` | Make stage wait for an approving review on the mirror PR |

`venfork stage approval` is a guardrail against publishing by accident or by an agent, not enforcement: anyone with push access can publish without venfork. It gates `venfork stage <branch>` only; `venfork stage issue` publishes redacted issue text, not code, and is not gated.

Every command takes `--yes`, `--no-input` and `--json`. Run `venfork help` for this list and `venfork <command> --help` for a command's options.

## Going further

- [Command reference](https://github.com/cabljac/venfork/blob/main/docs/reference/commands.md): every flag, what stage checks before it publishes, and the redaction markers.
- [Scheduled sync](https://github.com/cabljac/venfork/blob/main/docs/reference/scheduled-sync.md): tokens, the GitHub App, failure issues and version pins.
- [Output streams and JSON](https://github.com/cabljac/venfork/blob/main/docs/reference/json.md): the `--json` envelope, result shapes and error codes.
- [Headless, CI and environment variables](https://github.com/cabljac/venfork/blob/main/docs/reference/headless.md): prompts, `--yes`, exit codes and every environment variable.
- [Workflow, layout and troubleshooting](https://github.com/cabljac/venfork/blob/main/docs/reference/workflow.md): a full day-to-day workflow and fixes for common errors.
- [Migration](https://github.com/cabljac/venfork/blob/main/docs/reference/migration.md): upgrading mirrors made by older versions.
- [Development](https://github.com/cabljac/venfork/blob/main/docs/reference/development.md): building and testing venfork.

## Troubleshooting

Run `venfork doctor` first. It checks the remotes, the layout, divergence, kept files, the sync workflow, the git transport, the push token and the last scheduled run, and prints a fix for each failing check. More fixes are in [Workflow, layout and troubleshooting](https://github.com/cabljac/venfork/blob/main/docs/reference/workflow.md#troubleshooting).

## Tech Stack

- **Runtime:** Node.js 22+ (or Bun for faster development)
- **Language:** TypeScript (strict mode)
- **Shell Execution:** execa
- **CLI Framework:** @clack/prompts
- **Code Quality:** Biome

## License

MIT

## Contributing

Contributions are welcome! Please read our [Contributing Guide](https://github.com/cabljac/venfork/blob/main/CONTRIBUTING.md) to get started.

Key steps:
1. Fork and clone the repository
2. Install dependencies: `bun install`
3. Make your changes and add tests
4. Run checks: `bun run check && bun run test`
5. Use a conventional commit prefix (`feat:`, `fix:`, etc.) - release-please picks up the version bump from your commit message
6. Submit a pull request

## Support

If you encounter any issues or have questions:

1. Ensure you have the latest version installed
2. Open an issue on GitHub
---

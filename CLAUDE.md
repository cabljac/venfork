# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Venfork is

A CLI that creates and manages **private mirrors of public GitHub repos** for vendor/contractor workflows. Three-repository pattern:

- **Private mirror** (`origin`, `owner/project-private`) — where the team works; invisible to the client.
- **Public fork** (`public`, `owner/project`) — staging area for upstream contributions.
- **Upstream** (`upstream`, `original/project`) — read-only source; push is disabled (`git remote set-url --push upstream DISABLE`).

`--no-public` mode collapses this to `origin` + `upstream` only (use when you own upstream). The active layout is recorded as `mode: 'standard' | 'no-public'` in config.

## Commands (development)

Runtime is **Bun** (primary); Node.js 18+ is a supported target.

```bash
bun install              # deps
bun run dev <cmd> ...    # run CLI from src/ (e.g. bun run dev setup --help)
bun test                 # all tests
bun test tests/utils.test.ts          # single file
bun test -t "parses owner"            # single test by name
bun run test:watch                    # watch
bun run test:coverage                 # coverage
bun run check            # biome check + autofix (lint + format) — run before commit
bun run lint             # biome lint only
bun run build            # bundle to dist/ (node target)
bun run compile          # standalone binary -> dist/venfork
bun link                 # symlink global `venfork` for manual testing
```

E2E tests hit real GitHub and are gated behind env flags (slow, opt-in):

```bash
bun run test:e2e             # VENFORK_E2E=1
bun run test:e2e:dispatch    # + real workflow_dispatch
bun run test:e2e:cron        # + real scheduled cron
```

## Architecture

CLI entry `src/index.ts` parses `argv[0]` as the command and dispatches via a switch. Each command has a dedicated arg parser (`src/<command>-args.ts`) returning a typed options object, then calls the matching `*Command` function in `src/commands.ts`. To add/modify a command: touch the arg parser, the command impl, the `index.ts` switch, and `showHelp()`.

`src/commands.ts` is the bulk of the logic (~3400 lines, every `*Command`). The rest are focused modules:

- **`config.ts`** — the source of truth for persisted state. All cross-run state lives in `VenforkConfig` (`.venfork/config.json`) on an **orphan `venfork-config` branch** in the private mirror — never on a working branch. It tracks `upstreamUrl`, `publicForkUrl`, `mode`, `schedule`, workflow allow/block lists, the `preserve` allowlist, and link maps (`shippedBranches`, `pulledPrs`, `shippedIssues`, `pulledIssues`). Mutate via `updateVenforkConfig` with a `VenforkConfigPatch` (shallow-merge; `null` deletes an entry or clears a field). Read with `fetchVenforkConfig` (clones only the config branch to a temp dir) or `readVenforkConfigFromRepo`.
- **`git.ts`** — thin git/gh wrappers (`checkGhAuth`, `getRemotes`, `getDefaultBranch`, `ghRepoExists`, `ghRepoIsForkOf`, …).
- **`utils.ts`** — URL/shorthand parsing (`parseOwner`, `parseRepoName`, `parseRepoPath`, `normalizeGitHubRepoInput`); shorthand `owner/repo` is treated as `git@github.com:owner/repo.git`.
- **`workflow.ts`** — generates the deterministic GitHub Actions sync YAML (`.github/workflows/venfork-sync.yml`).
- **`errors.ts`** — typed errors (`VenforkError` + subclasses); `index.ts` prints `.message` and exits non-zero.

### The "+1 managed commit" model (the core invariant)

When scheduled sync or a `preserve` allowlist is active, the mirror's default branch is kept at **`upstream/<default>` plus exactly one deterministic venfork-managed commit** (subject `chore: venfork-managed mirror commit`). That commit carries the sync workflow YAML (filtered by `enabledWorkflows`/`disabledWorkflows`) and any preserved mirror-only files. `isManagedCommit` recognizes this subject plus legacy subjects so upgrades don't misclassify history as user divergence. Sync **aborts on divergent commits** to prevent data loss. When editing sync logic, preserve this single-managed-commit invariant — it's what lets sync stay idempotent and divergence-detectable.

### Internal-block redaction

`venfork stage --pr` and `venfork issue stage` promote internal content to upstream. Before doing so, `stripInternalBlocks` removes `<!-- venfork:internal -->…<!-- /venfork:internal -->` regions from PR/issue bodies. The markers are overridable via `VENFORK_INTERNAL_OPEN_RE` / `VENFORK_INTERNAL_CLOSE_RE`. Anything that flows from mirror → public/upstream must go through this redaction.

### Network-op safety

Every heavy git/gh network op goes through `netExec`/`runNetOp` in `commands.ts`: no stdin (credential/host-key prompts fail fast instead of hanging), a hard timeout (`VENFORK_GIT_TIMEOUT`, default 600s), and `BatchMode=yes`. Use these helpers for new network calls rather than raw `$` — a misconfigured credential should error, not block on an invisible prompt.

## Environment variables

- `VENFORK_ORG` — default org for created repos (`--org` flag overrides; no org → prompts before using personal account).
- `VENFORK_GIT_TIMEOUT` — ms cap per network op (default 600000).
- `VENFORK_NONINTERACTIVE=1` — auto-confirm prompts that explicitly opt in (`allowNonInteractive`); does **not** blanket-yes every prompt.
- `VENFORK_PUSH_TOKEN` — token used by the generated sync workflow for pushes.
- `VENFORK_BOT_NAME` / `VENFORK_BOT_EMAIL` — author identity for managed/config commits.
- `VENFORK_INTERNAL_OPEN_RE` / `VENFORK_INTERNAL_CLOSE_RE` — override internal-block markers.

## Conventions

- TypeScript strict mode; Biome for lint+format (`bun run check`). Releases via release-please (Conventional Commits drive version bumps + CHANGELOG).
- Tests use Bun's runner with `test()` (not `it()`).
- `gh repo clone` is used for fetching, so SSH-vs-HTTPS transport follows the user's `gh config get git_protocol`.

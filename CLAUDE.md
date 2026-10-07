# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Venfork is

A CLI that creates and manages **private mirrors of public GitHub repos** for vendor/contractor workflows. Three-repository pattern:

- **Private mirror** (`origin`, `owner/project-private`) — where the team works; invisible to the client.
- **Public fork** (`public`, `owner/project`) — staging area for upstream contributions.
- **Upstream** (`upstream`, `original/project`) — read-only source; push is disabled (`git remote set-url --push upstream DISABLE`).

`--no-public` mode collapses this to `origin` + `upstream` only (use when you own upstream). The active layout is recorded as `mode: 'standard' | 'no-public'` in config.

## Commands (development)

Runtime is **Bun** (primary); Node.js `^18.19.0 || >=20.5.0` (execa 9) is a supported target.

```bash
bun install              # deps
bun run dev <cmd> ...    # run CLI from src/ (e.g. bun run dev setup --help)
bun run test             # unit, then integration (two bun processes)
bun run test:unit        # tests/unit: string-mocked execa, fast
bun run test:integration # tests/integration: real git against local bare repos
bun test ./tests/unit/utils.test.ts      # single file
bun test -t "parses owner" ./tests/unit  # single test by name
bun run test:watch                    # watch
bun run test:coverage                 # coverage
bun run verify           # the only command that means "done": format:check, lint, typecheck, tests, node smoke (non-mutating)
bun run check            # biome check + autofix (lint + format); mutates files, so it is not a gate
bun run lint             # biome lint only
bun run build            # bundle to dist/ (node target)
bun run compile          # standalone binary -> dist/venfork
bun link                 # symlink global `venfork` for manual testing
```

Unit tests mock `execa` with `mock.module`, which leaks across files in one bun process, so integration tests run in a separate invocation. `bunfig.toml` sets the test root to `tests/unit`, so a bare `bun test` runs only unit tests; other suites need an explicit `./` path (`bun test ./tests/integration`). Integration tests build a throwaway upstream/origin/public layout of local bare repos with `tests/harness/mirror-fixture.ts` and run commands against it with only `@clack/prompts` mocked.

E2E tests hit real GitHub and are gated behind env flags (slow, opt-in):

```bash
bun run test:e2e             # VENFORK_E2E=1
bun run test:e2e:dispatch    # + real workflow_dispatch
```

## Architecture

CLI entry `src/index.ts` parses `argv[0]` as the command and dispatches via a switch. Each command has a dedicated arg parser (`src/<command>-args.ts`) returning a typed options object, then calls the matching `*Command` function in `src/commands/<command>.ts` (re-exported through the `src/commands.ts` barrel). To add/modify a command: touch the arg parser, the command impl, the `index.ts` switch, and `showHelp()`.

`src/commands/` holds one file per command. Helpers shared by several commands live in `src/shared/`: `net.ts` (network-op safety), `managed-commit.ts` (managed-commit detection), `mirror-commit.ts` (building the managed commit), `divergence.ts`, `redaction.ts`, `worktree.ts` (temporary detached worktrees), `confirm.ts`, `constants.ts`. The rest are focused modules:

- **`config.ts`** — the source of truth for persisted state. All cross-run state lives in `VenforkConfig` (`.venfork/config.json`) on an **orphan `venfork-config` branch** in the private mirror — never on a working branch. It tracks `upstreamUrl`, `publicForkUrl`, `mode`, `schedule`, workflow allow/block lists, the `preserve` allowlist, and link maps (`shippedBranches`, `pulledPrs`, `shippedIssues`, `pulledIssues`). Mutate via `updateVenforkConfig` with a `VenforkConfigPatch` (shallow-merge; `null` deletes an entry or clears a field). Read with `fetchVenforkConfig` (clones only the config branch to a temp dir) or `readVenforkConfigFromRepo`.
- **`git.ts`** — thin git/gh wrappers (`checkGhAuth`, `getRemotes`, `getDefaultBranch`, `ghRepoExists`, `ghRepoIsForkOf`, …).
- **`utils.ts`** — URL/shorthand parsing (`parseOwner`, `parseRepoName`, `parseRepoPath`, `normalizeGitHubRepoInput`); shorthand `owner/repo` is treated as `git@github.com:owner/repo.git`.
- **`workflow.ts`** — generates the deterministic GitHub Actions sync YAML (`.github/workflows/venfork-sync.yml`).
- **`errors.ts`** — typed errors (`VenforkError` + subclasses); `index.ts` prints `.message` and exits non-zero.

### The "+0/+1 managed commit" model (the core invariant)

When scheduled sync or a `preserve` allowlist is active, the mirror's default branch is kept at **`upstream/<default>` plus at most one venfork-managed commit** (subject `chore: venfork-managed mirror commit`, trailer `Venfork-Managed: 1`). That commit carries the sync workflow YAML (filtered by `enabledWorkflows`/`disabledWorkflows`) and any preserved mirror-only files. When that content adds nothing to the upstream tree (for example every preserved file now exists upstream), there is no managed commit and the mirror tip equals the upstream tip (+0).

Determinism rule: the managed commit's author and committer are the venfork bot and both dates are the committer date of the upstream tip, and it is built with `git commit-tree` (no hooks, no signing). Its SHA is therefore a function of the upstream tip and the tree. A sync with no upstream or config change rebuilds the same SHA, sees origin already points at it, and pushes nothing. When a push is needed it is a single `--force-with-lease=refs/heads/<default>:<previous tip>` push; public is skipped when it already equals upstream.

`isManagedCommit` checks the trailer first, then the current subject, the legacy subjects, and a workflow-path heuristic, so upgrades don't misclassify history as user divergence. Sync **aborts on divergent commits** (`SyncDivergenceError`) to prevent data loss. When editing sync logic, preserve this invariant: it is what lets sync stay idempotent and divergence-detectable.

### Internal-block redaction

`venfork stage --pr` and `venfork stage issue` promote internal content to upstream. Before doing so, `stripInternalBlocks` removes `<!-- venfork:internal -->…<!-- /venfork:internal -->` regions from PR/issue bodies and titles. Markers match case-insensitively (`<!-- VENFORK: internal (note) -->` works); an unmatched close marker or any leftover HTML comment mentioning venfork throws `RedactionError` instead of publishing. Anything that flows from mirror → public/upstream must go through this redaction. Stage also refuses (`StageLeakError`) to push a head whose diff against `upstream/<default>` adds the managed workflow or a preserved path upstream does not have.

### Health checks

`venfork doctor` (`src/commands/doctor.ts`) returns `{ id, ok: true | false | 'skipped', detail, fix? }` per check and exits 1 when any check is `false`. Git checks are covered by integration tests; the gh-backed checks (`token`, `last-run`, `cron-age`) are string-mocked in `tests/unit/doctor.test.ts` and degrade to `skipped` without gh auth or a GitHub origin.

### Network-op safety

Every heavy git/gh network op goes through `netExec`/`runNetOp` in `src/shared/net.ts`: no stdin (credential/host-key prompts fail fast instead of hanging), a hard timeout (`VENFORK_GIT_TIMEOUT`, default 600s), and `BatchMode=yes`. Use these helpers for new network calls rather than raw `$` — a misconfigured credential should error, not block on an invisible prompt.

## Environment variables

- `VENFORK_ORG` — default org for created repos (`--org` flag overrides; no org → prompts before using personal account).
- `VENFORK_GIT_TIMEOUT` — ms cap per network op (default 600000).
- `VENFORK_NONINTERACTIVE=1` — auto-confirm prompts that explicitly opt in (`allowNonInteractive`); does **not** blanket-yes every prompt.
- `VENFORK_PUSH_TOKEN` — token used by the generated sync workflow for pushes.
- `VENFORK_SEED_CHUNK` / `VENFORK_SEED_RETRY_MS` — commit batch size and retry delay for the initial mirror seed push.
- `VENFORK_INSTALL_SPEC` — repository variable read by the generated workflow to override the pinned `npm install -g` spec.

## Conventions

- TypeScript strict mode; Biome for lint+format (`bun run check`). Releases via release-please (Conventional Commits drive version bumps + CHANGELOG).
- Tests use Bun's runner with `test()` (not `it()`).
- `gh repo clone` is used for fetching, so SSH-vs-HTTPS transport follows the user's `gh config get git_protocol`.

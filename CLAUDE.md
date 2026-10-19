# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Venfork is

A CLI that creates and manages **private mirrors of public GitHub repos** for vendor/contractor workflows. Three-repository pattern:

- **Private mirror** (`origin`, `owner/project-private`) — where the team works; invisible to the client.
- **Public fork** (`public`, `owner/project`) — staging area for upstream contributions.
- **Upstream** (`upstream`, `original/project`) — read-only source; push is disabled (`git remote set-url --push upstream DISABLE`).

`--own-upstream` mode collapses this to `origin` + `upstream` only (use when you own upstream). The active layout is recorded as `mode: 'standard' | 'no-public'` in config.

User-facing names and on-disk names differ on purpose. The CLI says `venfork keep` and `--own-upstream`; the config keeps the field `preserve`, the value `mode: 'no-public'` and the doctor check id `preserve`, so every existing mirror reads unchanged and there is no migration. Code that talks to the user uses the new names; code that reads or writes config uses the old ones. The old spellings `venfork preserve` and `--no-public` exit 2 and name the new ones (`RENAMED` in `src/index.ts`, `renamedFlag` in `src/shared/args.ts`).

## Commands (development)

Runtime is **Bun** (primary); Node.js `>=22` is a supported target (`engines.node`; CI runs Node 22 and 24). `bun run smoke:node` fails when a runtime dependency needs a newer Node than `engines.node` allows.

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
bun run verify           # the only command that means "done": format:check, lint, lint:invariants, typecheck, tests, node smoke (non-mutating)
bun run check            # biome check + autofix (lint + format); mutates files, so it is not a gate
bun run lint             # biome lint only
bun run lint:invariants  # scripts/lint-invariants.ts repo invariant checks
bun run build            # bundle to dist/ (node target)
bun run compile          # standalone binary -> dist/venfork
bun link                 # symlink global `venfork` for manual testing
```

`bun run build` inlines every runtime dependency (`@clack/prompts`, `execa`), so `dist/index.js` imports only Node builtins and the published package has no `dependencies`: `npm install -g venfork` installs nothing else. Add runtime libraries to `devDependencies`. `bun run smoke:node` (part of verify and the release job) fails when the bundle imports a non-builtin, then packs the package, installs the tarball offline with `--omit=dev` into an empty project, checks that only `venfork` lands in `node_modules`, and runs its bin under Node.

Unit tests mock `execa` with `mock.module`, which leaks across files in one bun process, so integration tests run in a separate invocation. `bunfig.toml` sets the test root to `tests/unit`, so a bare `bun test` runs only unit tests; other suites need an explicit `./` path (`bun test ./tests/integration`). Integration tests build a throwaway upstream/origin/public layout of local bare repos with `tests/harness/mirror-fixture.ts` and run commands against it with only `@clack/prompts` mocked.

E2E tests hit real GitHub and are gated behind env flags (slow, opt-in):

```bash
bun run test:e2e             # VENFORK_E2E=1
bun run test:e2e:dispatch    # + real workflow_dispatch
```

Never run the real-GitHub e2e unless the user asks. It needs the test org (`memcard-dev`, or `VENFORK_E2E_ORG`) and a token with repo create and delete rights (`delete_repo` scope). Run it with `env -u GITHUB_TOKEN -u GH_TOKEN` so gh uses the keyring token (gh prefers `GH_TOKEN`, then `GITHUB_TOKEN`, then the keyring). To push with a specific token instead, set `VENFORK_E2E_PAT`; it overrides `gh auth token` as the e2e push token. Each run must leave no `venfork-e2e-*` repos behind: check with `gh repo list "${VENFORK_E2E_ORG:-memcard-dev}" --limit 1000 | grep venfork-e2e-` (and the same for `${VENFORK_E2E_UPSTREAM_OWNER:-cabljac}`). The default proof for a change is `bun run verify` plus a harness drive (`.agents/skills/verify-venfork/`). A PR that did not rerun e2e must state "Not verified: e2e tiers".

## Architecture

CLI entry `src/index.ts` parses `argv[0]` as the command and dispatches via a switch. Each command has a dedicated arg parser (`src/<command>-args.ts`) returning a typed options object, then calls the matching `*Command` function in `src/commands/<command>.ts` (re-exported through the `src/commands.ts` barrel). To add/modify a command: touch the arg parser, the command impl, the `index.ts` switch, and `showHelp()`.

`src/commands/` holds one file per command. Helpers shared by several commands live in `src/shared/`: `net.ts` (network-op safety), `managed-commit.ts` (managed-commit detection), `mirror-commit.ts` (building the managed commit), `divergence.ts`, `redaction.ts`, `worktree.ts` (temporary detached worktrees), `prompt.ts` (every interactive prompt), `ui.ts` (all human output, on stderr), `json-output.ts` (the one `--json` envelope: a command returns its result, `src/index.ts` writes it, `error.code` comes from `VenforkError.code`, and a failed `git`/`gh` subprocess maps to `git`/`github`), `interrupt.ts` (a command that handles SIGINT/SIGTERM itself claims them, so the `--json` signal envelope waits for its rejection), `constants.ts`. The rest are focused modules:

- **`config.ts`** — the source of truth for persisted state. All cross-run state lives in `VenforkConfig` (`.venfork/config.json`) on an **orphan `venfork-config` branch** in the private mirror — never on a working branch. It tracks `upstreamUrl`, `publicForkUrl`, `mode`, `schedule`, `scheduleAuth` (top level; `'app'` or absent for token auth), workflow allow/block lists, the `preserve` allowlist, and link maps (`shippedBranches`, `pulledPrs`, `shippedIssues`, `pulledIssues`). Mutate via `updateVenforkConfig` with a `VenforkConfigPatch` (shallow-merge; `null` deletes an entry or clears a field). Read with `fetchVenforkConfig` (clones only the config branch to a temp dir) or `readVenforkConfigFromRepo`.
- **`git.ts`** — thin git/gh wrappers (`checkGhAuth`, `getRemotes`, `getDefaultBranch`, `ghRepoExists`, `ghRepoIsForkOf`, …).
- **`utils.ts`** — URL/shorthand parsing (`parseOwner`, `parseRepoName`, `parseRepoPath`, `normalizeGitHubRepoInput`); shorthand `owner/repo` is treated as `git@github.com:owner/repo.git`.
- **`workflow.ts`** — generates the deterministic GitHub Actions sync YAML (`.github/workflows/venfork-sync.yml`).
- **`errors.ts`** — typed errors (`VenforkError` + subclasses); `index.ts` prints `.message` and exits 1, or 2 for `UsageError` (malformed input) and `MissingInputError` (no prompt possible). Commands never call `process.exit`: one that already printed its outcome throws `CommandExitError(code)`, which `index.ts` turns into that exit code without printing more. A command's catch rethrows `isEntryReported` errors unchanged.

### The "+0/+1 managed commit" model (the core invariant)

When scheduled sync or a `preserve` allowlist is active, the mirror's default branch is kept at **`upstream/<default>` plus at most one venfork-managed commit** (subject `chore: venfork-managed mirror commit`, trailer `Venfork-Managed: 1`). That commit carries the sync workflow YAML (filtered by `enabledWorkflows`/`disabledWorkflows`) and any preserved mirror-only files. When that content adds nothing to the upstream tree (for example every preserved file now exists upstream), there is no managed commit and the mirror tip equals the upstream tip (+0).

Determinism rule: the managed commit's author and committer are the venfork bot and both dates are the committer date of the upstream tip, and it is built with `git commit-tree` (no hooks, no signing). Its SHA is therefore a function of the upstream tip and the tree. A sync with no upstream or config change rebuilds the same SHA, sees origin already points at it, and pushes nothing. When a push is needed it is a single `--force-with-lease=refs/heads/<default>:<previous tip>` push; public is skipped when it already equals upstream.

`isManagedCommit` checks the trailer first, then the current subject, the legacy subjects, and a workflow-path heuristic, so upgrades don't misclassify history as user divergence. Sync **aborts on divergent commits** (`SyncDivergenceError`) to prevent data loss. When editing sync logic, preserve this invariant: it is what lets sync stay idempotent and divergence-detectable.

### Internal-block redaction

`venfork stage` (unless `--no-pr`) and `venfork stage issue` promote internal content to upstream. Before doing so, `stripInternalBlocks` removes `<!-- venfork:internal -->…<!-- /venfork:internal -->` regions from PR/issue bodies and titles. Markers match case-insensitively (`<!-- VENFORK: internal (note) -->` works); an unmatched close marker or any leftover HTML comment mentioning venfork throws `RedactionError` instead of publishing. Anything that flows from mirror → public/upstream must go through this redaction. Stage also refuses (`StageLeakError`) to push a head whose diff against `upstream/<default>` adds the managed workflow or a preserved path upstream does not have.

### Health checks

`venfork doctor` (`src/commands/doctor.ts`) returns `{ id, ok: true | false | 'skipped', detail, fix? }` per check and exits 1 when any check is `false`. Git checks are covered by integration tests; the network checks (`transport`, `token`, `last-run`, `cron-age`) are string-mocked in `tests/unit/doctor.test.ts`. `token`, `last-run` and `cron-age` degrade to `skipped` without gh auth or a GitHub origin; `transport` skips only for a non-GitHub origin.

### Output streams

stdout carries only results (`--version`, help that was asked for, and the one `--json` envelope). Everything else goes to stderr through the `src/shared/ui.ts` facade (`log`, `note`, `spinner`, `intro`, `outro`, `cancel`), and prompts render on stderr too. The facade delegates to clack when stderr is a TTY, `NO_COLOR` is unset or empty and `TERM` is not `dumb`, and prints plain `prefix message` lines otherwise. Subprocess stdout from `netExec` is routed to stderr. The test preload pins `process.stderr.isTTY` to true so ui output reaches the mocked `@clack/prompts`; assert clack calls with `ON_STDERR` from `tests/harness/prompts.ts`.

### Network-op safety

Every heavy git/gh network op goes through `netExec`/`runNetOp` in `src/shared/net.ts`: no stdin (credential/host-key prompts fail fast instead of hanging), a hard timeout (`VENFORK_GIT_TIMEOUT`, default 600s), and `BatchMode=yes`. Use these helpers for new network calls rather than raw `$` — a misconfigured credential should error, not block on an invisible prompt.

`netExec` also puts `-c credential.https://github.com.helper= -c credential.https://github.com.helper=!gh auth git-credential` right after `git` on every git command it runs, so an HTTPS github.com remote authenticates with gh (`GH_TOKEN` or `gh auth login`) without `gh auth setup-git`. The empty entry resets the helper list for `https://github.com`, so gh is the only helper there: the user's own helper (osxkeychain, store) is never asked and never stores a gh token, which would go stale. The helper is scoped to `https://github.com`, so local-path remotes and other hosts never reach it, and a missing or unauthenticated gh fails closed (`terminal prompts disabled`). Run non-network git through plain `$` so it does not get the helper. In the generated workflow, actions/checkout's `http.https://github.com/.extraheader` sends the push token on every request from the checkout, so git does not ask a helper for those fetches and pushes.

### Verifying behaviour

`.agents/skills/verify-venfork/` is the per-command behaviour reference: one feature file per `src/commands/<name>.ts`, plus leak invariants and multi-command journeys.
`bun scripts/verify-fixture.ts [--shell]` is the harness lever: it builds the local upstream/origin/public fixture and prints the paths and env to drive the built CLI against it.

## Environment variables

- `VENFORK_ORG` — default org for created repos (`--org` flag overrides; no org → prompts before using personal account).
- `VENFORK_GIT_TIMEOUT` — ms cap per network op (default 600000).
- `VENFORK_NONINTERACTIVE=1` - never prompt, like `--no-input`; it does not confirm (only `--yes` does). venfork also never prompts without a TTY on stdin and stderr or with `CI` set (not `false`/`0`); a prompt it cannot show exits 2 (`MissingInputError`) naming the flag. Every command accepts `--no-input` (a no-op where nothing prompts).
- `VENFORK_PUSH_TOKEN` — token used by the generated sync workflow for pushes.
- `VENFORK_APP_CLIENT_ID` / `VENFORK_APP_PRIVATE_KEY` - repo secrets the generated workflow mints its push token from when `scheduleAuth` is `app` (`schedule set --app`).
- `VENFORK_E2E_APP_CLIENT_ID` / `VENFORK_E2E_APP_PRIVATE_KEY` - GitHub App credentials that enable the App variant of the e2e dispatch tier.
- `VENFORK_SEED_CHUNK` / `VENFORK_SEED_RETRY_MS` — commit batch size and retry delay for the initial mirror seed push.
- `VENFORK_INSTALL_SPEC` — repository variable read by the generated workflow to override the pinned `npm install -g` spec.
- `VENFORK_ALLOW_SELF_REFERENCE=1` — stops `stage` refusing the bare word `venfork` in commit messages, PR titles and bodies (mirror URL, owner and repo terms stay refused).

## Conventions

- TypeScript strict mode; Biome for lint+format (`bun run check`). Releases via release-please (Conventional Commits drive version bumps + CHANGELOG).
- Tests use Bun's runner with `test()` (not `it()`).
- Review and PR shape: use `.agents/skills/review-venfork/` for adversarial review and `.github/pull_request_template.md` for PR bodies.
- Known traps live in `docs/agents/gotchas.md`; append there after a correction.
- `gh repo clone` is used for fetching, so SSH-vs-HTTPS transport follows the user's `gh config get git_protocol`.
- Invariants (remote refs, git network ops, dynamic git subcommands and `gh api` / `gh repo clone|view` via net.ts, import boundary, `gh pr|issue create|edit` only in `src/shared/upstream-publish.ts`, process.exit, clack prompts only in `src/shared/prompt.ts`, `@clack/prompts` imported only in `src/shared/ui.ts` and `src/shared/prompt.ts`) are enforced by scripts/lint-invariants.ts.

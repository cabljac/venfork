# venfork e2e

Real end-to-end tests that hit GitHub. A bare `bun test` never loads this
suite: `bunfig.toml` sets the test root to `./tests/unit`.

## Owner split

GitHub forbids a single user account from owning both a parent and a fork,
so the test uses two distinct owners:

| Role | Default | Override env var |
|---|---|---|
| Upstream | `cabljac` (user) | `VENFORK_E2E_UPSTREAM_OWNER` |
| Mirror + public fork | `memcard-dev` (org) | `VENFORK_E2E_ORG` |

The test fails fast in `beforeAll` if both resolve to the same owner. The
authenticated `gh` user must have permission to create repos in both owners
(typically the gh user IS the upstream owner, and is a member with repo-create
rights in the mirror/fork org).

## What it covers

**Tier 1** (default) - runs `venfork sync` locally against real GitHub:

1. Creates a fresh upstream repo (`<upstream-owner>/venfork-e2e-src-<id>`).
2. Drives `venfork setup` to create the private mirror + public fork and clone
   the mirror into `tmp/venfork-e2e-<id>/`.
3. Enables scheduled sync (`venfork schedule set "*/5 * * * *"`) and asserts the
   workflow file + `venfork-config` JSON are correct.
4. Pushes a new commit to upstream via the GitHub contents API.
5. Runs `venfork sync` locally and asserts:
   - `public/<default>` SHA == upstream SHA (no `+1` commit).
   - `origin/<default>` is upstream + one workflow commit (parent of mirror tip
     equals the upstream tip).

**Tier 2** (opt-in via `VENFORK_E2E_REAL_DISPATCH=1`) - runs the same sync inside
a real GitHub Actions runner via `gh workflow run`:

1. Tier 1 setup leaves the workflow on origin/main. Its first step fails the
   job when the `VENFORK_PUSH_TOKEN` secret is empty, and `actions/checkout`
   uses `token: ${{ secrets.VENFORK_PUSH_TOKEN }}` with no fallback.
2. Sets `VENFORK_PUSH_TOKEN` on the mirror to either `$VENFORK_E2E_PAT` or
   `gh auth token` (default).
3. Packs the build from `beforeAll` with `npm pack`, uploads the tarball as a
   release asset on the public upstream repo, and sets the mirror's
   `VENFORK_INSTALL_SPEC` repository variable to the asset URL. The runner
   therefore installs the code under test, not the published venfork.
4. Pushes another commit to upstream and `gh workflow run`s the dispatch.
5. Polls `gh run list` for the dispatched run, then `gh run view` for completion.
6. Asserts the run conclusion is `success`, the same SHA invariants hold, and
   no open `venfork-sync-blocked` issue exists on the mirror.

**Tiers 3-5** (default) - run against the repos tier 1 created:

- Tier 3: `venfork stage --pr` opens the upstream PR with
  `<!-- venfork:internal -->` blocks redacted.
- Tier 4: `venfork pull pr` imports an upstream PR, and `venfork sync`
  refreshes it after the contributor pushes again.
- Tier 5: `venfork stage issue` and `venfork pull issue` round-trip issues.

**Tier 6** (opt-in via `VENFORK_E2E_REAL_DISPATCH=1`) - pins that a mirror
without `VENFORK_PUSH_TOKEN` fails fast and says why, in no-public mode too:

1. Sets up a second, no-public mirror and enables scheduled sync, with no
   `VENFORK_PUSH_TOKEN` secret.
2. Pushes an upstream commit and dispatches the sync workflow.
3. Asserts the run fails at the `Check VENFORK_PUSH_TOKEN` step with
   the `VENFORK_PUSH_TOKEN is not set on this repository` error annotation, the install
   and sync steps are skipped, the mirror's default branch does not move, and
   exactly one open `venfork-sync-blocked` issue exists whose body names the
   missing secret as the cause.

Tier 6 needs no extra token: it deliberately sets no secret.

Every tier cleans up its repos and `tmp/<run-id>/` in `afterAll` regardless
of pass/fail.

## Prerequisites

- `gh` CLI authenticated: `gh auth login`.
- The token must include the `delete_repo` scope or cleanup will leak repos:
  ```
  gh auth refresh -s delete_repo
  ```
- Repo create and delete rights in both owners: the upstream owner
  (`${VENFORK_E2E_UPSTREAM_OWNER:-cabljac}`) and the mirror org
  (`${VENFORK_E2E_ORG:-memcard-dev}`).
- `bun` available (the test runs `bun run build` in `beforeAll`).

## How to run

```bash
# Tiers 1, 3, 4, 5 - local commands against real GitHub
bun run test:e2e

# Every tier, including the workflow_dispatch runs (tiers 2 and 6, about 4-5 min)
bun run test:e2e:dispatch

# Same, with a fine-grained PAT for tier 2 instead of your gh OAuth token.
# It needs Contents: write and Workflows: write on the test repos.
VENFORK_E2E_PAT=github_pat_… bun run test:e2e:dispatch
```

`bun test ./tests/e2e` without `VENFORK_E2E=1` loads this file but replaces
the `describe` block with `describe.skip`, so no GitHub calls are made.

## Environment variables

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `VENFORK_E2E` | yes (to run) | unset | Set to `1` to actually run the e2e describe block |
| `VENFORK_E2E_UPSTREAM_OWNER` | no | `cabljac` | GitHub owner of the synthetic upstream repo |
| `VENFORK_E2E_ORG` | no | `memcard-dev` | GitHub org for the mirror + public fork |
| `VENFORK_E2E_REAL_DISPATCH` | no | unset | Run the tier 2 and tier 6 workflow_dispatch tests |
| `VENFORK_E2E_PAT` | no | falls back to `gh auth token` | Token written as the `VENFORK_PUSH_TOKEN` secret on the mirror in Tier 2. Override with a fine-grained PAT scoped to just the test repos if you don't want the test using your full gh OAuth token. |
| `VENFORK_E2E_APP_CLIENT_ID` | no | unset | Client ID of the GitHub App for the App variant of Tier 2. Without it (or the key), that variant is skipped. |
| `VENFORK_E2E_APP_PRIVATE_KEY` | no | unset | PEM private key of the same App, written as the `VENFORK_APP_PRIVATE_KEY` secret. |

## How Tier 2 authenticates cross-repo pushes

The workflow `venfork schedule set` generates starts with a `Check
VENFORK_PUSH_TOKEN` step that fails the job when the secret is empty. It then
wires `token: ${{ secrets.VENFORK_PUSH_TOKEN }}` on `actions/checkout@v4`,
plus a step that rewrites SSH GitHub URLs to HTTPS so `actions/checkout`'s
extraheader auth applies to all push targets.

Tier 2 sets the `VENFORK_PUSH_TOKEN` secret on the mirror. It does not patch
the workflow: the install spec is overridden through the
`VENFORK_INSTALL_SPEC` repository variable that the generated workflow reads,
so the runner executes the code under test. The install step accepts only
`venfork@<semver>` or an `https://` URL ending in `.tgz`; the release asset
URL the test uploads has that form. The helper `getPushToken()`
returns `$VENFORK_E2E_PAT` if set, otherwise `gh auth token` (your local OAuth
token). The secret, the variable and the release are removed automatically
when the test repos are deleted in `afterAll`.

## Tier 2 under GitHub App auth

Tier 2 runs twice on the same repos: first with `VENFORK_PUSH_TOKEN`, then
with GitHub App auth. The App variant runs `venfork schedule set <cron> --app`,
which rebuilds the managed commit with the mint step. It sets the
`VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` secrets, deletes
`VENFORK_PUSH_TOKEN` and dispatches the workflow again. It needs
`VENFORK_E2E_REAL_DISPATCH=1` and both `VENFORK_E2E_APP_*` variables.

Create the App once in the e2e org (`VENFORK_E2E_ORG`, default
`memcard-dev`), with no webhook and the repository permissions Contents: read
and write and Workflows: read and write. Install it on **All repositories**
of that org: the test repos are created per run, so a selected-repositories
install cannot include them.

```bash
VENFORK_E2E_APP_CLIENT_ID=Iv23… \
VENFORK_E2E_APP_PRIVATE_KEY="$(cat app-key.pem)" \
bun run test:e2e:dispatch
```

## If a run is interrupted

Repos are named `venfork-e2e-*-<8 hex chars>`. If you Ctrl-C in the middle of a
run, `afterAll` may not get a chance to delete them. Audit and clean up:

```bash
for owner in "${VENFORK_E2E_UPSTREAM_OWNER:-cabljac}" "${VENFORK_E2E_ORG:-memcard-dev}"; do
  gh repo list "$owner" --limit 100 \
    | grep venfork-e2e- \
    | awk '{print $1}' \
    | xargs -I{} gh repo delete {} --yes
done
```

Local clones live under `tmp/` (gitignored); `rm -rf tmp/` is safe.

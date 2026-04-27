# venfork e2e

Real end-to-end tests that hit GitHub. The default `bun test` skips this suite.

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

**Tier 1** (default) — runs `venfork sync` locally against real GitHub:

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

**Tier 2** (opt-in via `VENFORK_E2E_REAL_DISPATCH=1`) — runs the same sync inside
a real GitHub Actions runner via `gh workflow run`:

1. Tier 1 setup leaves the workflow on origin/main with venfork's native
   `with: token: ${{ secrets.VENFORK_PUSH_TOKEN || github.token }}` wiring.
2. Sets `VENFORK_PUSH_TOKEN` on the mirror to either `$VENFORK_E2E_PAT` or
   `gh auth token` (default).
3. Pushes another commit to upstream and `gh workflow run`s the dispatch.
4. Polls `gh run list` for the dispatched run, then `gh run view` for completion.
5. Asserts the run conclusion is `success` and the same SHA invariants hold.

Both tiers clean up all three repos and `tmp/<run-id>/` in `afterAll` regardless
of pass/fail.

## Prerequisites

- `gh` CLI authenticated: `gh auth login`.
- The token must include the `delete_repo` scope or cleanup will leak repos:
  ```
  gh auth refresh -s delete_repo
  ```
- Push access to `${VENFORK_E2E_ORG:-cabljac}` for repo creation/deletion.
- `bun` available (the test runs `bun run build` in `beforeAll`).

## How to run

```bash
# Tier 1 only — local sync e2e (~60–120s)
bun run test:e2e

# Tier 1 + Tier 2 (workflow_dispatch on real GHA runner, ~90–120s total)
bun run test:e2e:dispatch

# Tier 1 + Tier 2 with explicit PAT (fine-grained, scoped to just the test repos)
VENFORK_E2E_PAT=ghp_… bun run test:e2e:dispatch

# Tier 1 + Tier 2 slow real-cron (still a stub; opt-in via VENFORK_E2E_REAL_CRON)
bun run test:e2e:cron
```

The default `bun test` (no env var) loads this file but the `describe` block
is replaced with `describe.skip`, so no GitHub calls are made.

## Environment variables

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `VENFORK_E2E` | yes (to run) | unset | Set to `1` to actually run the e2e describe block |
| `VENFORK_E2E_UPSTREAM_OWNER` | no | `cabljac` | GitHub owner of the synthetic upstream repo |
| `VENFORK_E2E_ORG` | no | `memcard-dev` | GitHub org for the mirror + public fork |
| `VENFORK_E2E_REAL_DISPATCH` | no | unset | Run Tier 2 workflow_dispatch test |
| `VENFORK_E2E_REAL_CRON` | no | unset | Run Tier 2 real-cron wait (still a stub) |
| `VENFORK_E2E_PAT` | no | falls back to `gh auth token` | Token written as the `VENFORK_PUSH_TOKEN` secret on the mirror in Tier 2. Override with a fine-grained PAT scoped to just the test repos if you don't want the test using your full gh OAuth token. |

## How Tier 2 authenticates cross-repo pushes

The workflow `venfork schedule set` generates wires
`token: ${{ secrets.VENFORK_PUSH_TOKEN || github.token }}` on
`actions/checkout@v4`, plus a step that rewrites SSH GitHub URLs to HTTPS so
`actions/checkout`'s extraheader auth applies to all push targets.

Tier 2 just needs to set the `VENFORK_PUSH_TOKEN` secret on the mirror — no
workflow patching. The helper `getPushToken()` returns `$VENFORK_E2E_PAT` if
set, otherwise `gh auth token` (your local OAuth token). The secret is removed
automatically when the test repo is deleted in `afterAll`.

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

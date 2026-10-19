---
command: sync
entry: src/commands/sync.ts
shared: [net, divergence, json-output, managed-commit, mirror-commit, stage-gate, sync-report]
config:
  read: [mode, preserve, invalidPreserve, schedule, enabledWorkflows, disabledWorkflows, pulledPrs]
  written: [pulledPrs]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/sync-args.test.ts, tests/unit/sync-report.test.ts, tests/unit/json-output.test.ts]
  integration: [tests/integration/cli.test.ts, tests/integration/sync.test.ts, tests/integration/sync-snapshot.test.ts, tests/integration/sync-preserve-guard.test.ts, tests/integration/tip-builder.test.ts, tests/integration/integrity.test.ts, tests/integration/config.test.ts, tests/integration/net-credential.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Fetches upstream and origin, then reads the config, then fetches public (not in no-public mode).
- Builds the origin tip: the upstream tip, plus one managed commit when a schedule, a preserve list or a workflow allow/block list is active. Else origin equals upstream (+0).
- The managed commit is deterministic (bot identity, upstream committer date, `Venfork-Managed: 1`). No upstream or config change means the same SHA and no push.
- One `--force-with-lease` push per remote, skipped when the remote already has the target. Public is set to the upstream tip.
- Commits that touch only preserved paths on origin are folded into the managed commit, not divergence.
- Divergence (`SyncDivergenceError`) prints one `error:` line: the counts, up to three files, then the hint (`venfork keep add '<file>' ...` for origin's files, each single-quoted, when 1 to 10 of them can be preserved, and "move the commits to a branch and retry"). No warning note, no force-push advice. `--json` carries `hint` and `details: { branch, origin, public, command? }`. The `--report-issues` issue body keeps the full report.
- Sync takes no branch. `sync <anything>` is a usage error (exit 2) that names `venfork pull pr <n>` (with the number for `upstream-pr/<n>`); refreshing a pulled PR is a `pull pr` re-run (see `pull-request.md`).
- `--json` prints one envelope line on stdout. Default branch: `result` is `{ kind: 'default-branch', status: 'pushed' | 'up-to-date', branch, upstreamTip, origin: { tip, pushed }, public?: { tip, pushed } }` (`public` absent in no-public mode). A failure is `ok: false` with `error.code`, for example `sync-divergence`.
- Every git fetch, push and ls-remote runs through `netExec`, which puts `-c credential.https://github.com.helper= -c credential.https://github.com.helper=!gh auth git-credential` after `git`. An HTTPS github.com remote then authenticates with gh only: the empty entry clears the user's helpers for that URL, so no user helper is asked for the token or writes it. Other hosts keep the user's helpers and never reach gh. Local-path remotes never reach a helper. `tests/integration/net-credential.test.ts` pins this with fake helpers (gh fails or is missing: fail fast, no prompt; gh is the only github.com helper; the token is not stored; other hosts use the user's helper), and `tests/unit/net.test.ts` pins the flag order.
- `--report-issues` opens or refreshes a `venfork-sync-blocked` issue on divergence and closes it on success (gh only).
- Errors: `SyncDivergenceError` (origin or public has non-upstream commits), `ConfigError` (bad config JSON, invalid preserve entry, bad cron), `GitError` "origin/main moved since this sync fetched it" (stale lease), `PinDowngradeError` (origin pins a newer venfork), `UnmigratedMirrorError` (unpinned workflow with `GITHUB_ACTIONS=true`), plain error when the config branch is missing but origin carries a managed commit, `NotInRepositoryError` outside a git repository. `sync a` and `sync a b` are usage errors (exit 2).

## How a user reaches it

`venfork sync`, `venfork sync --report-issues` (the generated workflow), `venfork sync --json`. No prompt; `--no-input` is accepted and changes nothing.

## How to drive it

```bash
N=$(vf_pushes "$VF_ORIGIN"); venfork sync </dev/null 2>&1 | grep "already up to date"   # 2 lines: origin and public
echo "$N $(vf_pushes "$VF_ORIGIN")"                                        # equal
venfork schedule set "0 * * * *" </dev/null >/dev/null 2>&1                # managed commit on
vf_upstream_commit src/new.txt new && venfork sync </dev/null 2>&1 | grep Updated
venfork sync </dev/null 2>&1 | grep -c "already up to date"                # 2, and no new push
venfork sync --json </dev/null 2>/dev/null | jq -c '[.ok, .result.status]'      # [true,"up-to-date"]
vf_origin_commit src/hotfix.txt hot; venfork sync </dev/null 2>&1 | grep "Sync aborted"  # SyncDivergenceError, exit 1
venfork sync --json </dev/null 2>/dev/null | jq -r .error.code; echo "${PIPESTATUS[0]}" # sync-divergence, 1
```

- Concurrent lease: build the stale copy (features/README.md), `vf_upstream_commit`, then `vf_origin_commit` a teammate commit, swap the fetch URL, `venfork sync` exits 1 with "origin/main moved since this sync fetched it". The teammate commit stays on origin.
- `venfork sync upstream-pr/1 </dev/null 2>&1; echo $?` prints the usage error naming `venfork pull pr 1` and 2.
- Pin guard: after `schedule set`, `vf_origin_commit .github/workflows/venfork-sync.yml "$(git -C "$VF_ORIGIN" show main:.github/workflows/venfork-sync.yml | sed "s/venfork@$(venfork --version)/venfork@9.9.9/")" "$(printf 'chore: venfork-managed mirror commit\n\nVenfork-Managed: 1')"`, `vf_upstream_commit src/n.txt n`, `venfork sync`: exit 1, "origin pins venfork 9.9.9, you are running <the version `venfork --version` prints>".
- Cancel: there is no prompt. `venfork sync --json` killed with SIGINT prints the `cancelled` envelope and exits 130 (`tests/integration/cli.test.ts`); killed with SIGTERM it prints the same envelope ("Interrupted by SIGTERM") and exits 143 (also pinned). To drive it, put a `git` wrapper first on `PATH` that sleeps on `fetch`, start `venfork sync --json &`, then `kill -INT` it.

## What proves it

- `vf_tip "$VF_ORIGIN" main^` equals `vf_tip "$VF_UPSTREAM"` with the managed commit, or `vf_tip "$VF_ORIGIN"` equals it at +0.
- `git -C "$VF_ORIGIN" log -1 --format='%an %cd%n%B' --date=raw main`: `venfork-bot`, the upstream tip's committer date, `Venfork-Managed: 1`.
- `vf_pushes` unchanged after a no-op sync. `vf_tip "$VF_PUBLIC"` equals `vf_tip "$VF_UPSTREAM"`.
- After an error, `vf_tip "$VF_ORIGIN"` is unchanged. The failing `doctor --json` check depends on the error: a divergence error gives `divergence` and `invariant` false; the pin guard gives `workflow` and `invariant` false with `divergence` ok; a stale lease leaves `divergence` ok.

## What usually lies

- The outro "Sync complete!" also prints after a no-op. Read the spinner lines (`step:` / `done:` on stderr).
- `venfork sync >/dev/null` still shows all progress: sync writes nothing to stdout, and git's output goes to stderr too.
- Unit tests answer `git rev-parse` and `git push` with strings. They cannot show a lease or a SHA.

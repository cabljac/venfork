---
command: sync
entry: src/commands/sync.ts
shared: [net, divergence, managed-commit, mirror-commit, stage-gate, sync-report]
config:
  read: [mode, preserve, invalidPreserve, schedule, enabledWorkflows, disabledWorkflows, pulledPrs]
  written: [pulledPrs]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/sync-args.test.ts, tests/unit/sync-report.test.ts]
  integration: [tests/integration/sync.test.ts, tests/integration/sync-snapshot.test.ts, tests/integration/sync-preserve-guard.test.ts, tests/integration/tip-builder.test.ts, tests/integration/integrity.test.ts, tests/integration/config.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Fetches upstream and origin, then reads the config, then fetches public (not in no-public mode).
- Builds the origin tip: the upstream tip, plus one managed commit when a schedule, a preserve list or a workflow allow/block list is active. Else origin equals upstream (+0).
- The managed commit is deterministic (bot identity, upstream committer date, `Venfork-Managed: 1`). No upstream or config change means the same SHA and no push.
- One `--force-with-lease` push per remote, skipped when the remote already has the target. Public is set to the upstream tip.
- Commits that touch only preserved paths on origin are folded into the managed commit, not divergence.
- `sync <branch>` for a pulled PR (`pulledPrs[branch]` or the name `upstream-pr/<n>`) refetches `pull/<n>/head`, pushes it to origin with a lease and rewrites `pulledPrs[branch]`. Any other branch name is synced as the default branch.
- `--report-issues` opens or refreshes a `venfork-sync-blocked` issue on divergence and closes it on success (gh only).
- Errors: `SyncDivergenceError` (origin or public has non-upstream commits), `ConfigError` (bad config JSON, invalid preserve entry, bad cron), `GitError` "origin/main moved since this sync fetched it" (stale lease), `PinDowngradeError` (origin pins a newer venfork), `UnmigratedMirrorError` (unpinned workflow with `GITHUB_ACTIONS=true`), plain error when the config branch is missing but origin carries a managed commit.

## How a user reaches it

`venfork sync`, `venfork sync develop`, `venfork sync upstream-pr/12`, `venfork sync --report-issues` (the generated workflow). No prompt.

## How to drive it

```bash
N=$(vf_pushes "$VF_ORIGIN"); venfork sync </dev/null 2>&1 | tail -3      # already current: "already up to date"
echo "$N $(vf_pushes "$VF_ORIGIN")"                                        # equal
venfork schedule set "0 * * * *" </dev/null >/dev/null 2>&1                # managed commit on
vf_upstream_commit src/new.txt new && venfork sync </dev/null 2>&1 | grep Updated
venfork sync </dev/null 2>&1 | grep -c "already up to date"                # 2, and no new push
vf_origin_commit src/hotfix.txt hot; venfork sync </dev/null 2>&1 | tail -1  # exit 1, SyncDivergenceError
```

- Concurrent lease: build the stale copy (README), `vf_upstream_commit`, then `vf_origin_commit` a teammate commit, swap the fetch URL, `venfork sync` exits 1 with "origin/main moved since this sync fetched it". The teammate commit stays on origin.
- Pulled PR: `git -C "$VF_PUBLIC" push -q "$VF_UPSTREAM" <branch>:refs/pull/1/head`, then `venfork sync upstream-pr/1`. A second run pushes nothing to the branch.
- Pin guard: after `schedule set`, `vf_origin_commit .github/workflows/venfork-sync.yml "$(git -C "$VF_ORIGIN" show main:.github/workflows/venfork-sync.yml | sed s/venfork@0.11.0/venfork@9.9.9/)" "$(printf 'chore: venfork-managed mirror commit\n\nVenfork-Managed: 1')"`, `vf_upstream_commit src/n.txt n`, `venfork sync`: exit 1, "origin pins venfork 9.9.9, you are running 0.11.0". Use the version `venfork --version` prints.
- Cancel: there is no prompt, so there is no 130 path.

## What proves it

- `vf_tip "$VF_ORIGIN" main^` equals `vf_tip "$VF_UPSTREAM"` with the managed commit, or `vf_tip "$VF_ORIGIN"` equals it at +0.
- `git -C "$VF_ORIGIN" log -1 --format='%an %cd%n%B' --date=raw main`: `venfork-bot`, the upstream tip's committer date, `Venfork-Managed: 1`.
- `vf_pushes` unchanged after a no-op sync. `vf_tip "$VF_PUBLIC"` equals `vf_tip "$VF_UPSTREAM"`.
- After an error, `vf_tip "$VF_ORIGIN"` is unchanged. `doctor --json` shows `divergence` false.

## What usually lies

- The outro "Sync complete!" also prints after a no-op. Read the spinner lines.
- `sync upstream-pr/<n>` only warns when the origin push fails and still exits 0 with "synced". Check `vf_tip "$VF_ORIGIN" upstream-pr/<n>`.
- `sync upstream-pr/<n>` writes a new `venfork-config` commit every run (`lastSyncedAt`), even when the branch did not move.
- With a local-path upstream, `pulledPrs[...].upstreamPrUrl` is a made-up `https://github.com/<dir>/upstream/pull/<n>`.
- Unit tests answer `git rev-parse` and `git push` with strings. They cannot show a lease or a SHA.

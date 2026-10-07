---
command: schedule
entry: src/commands/schedule.ts
shared: [config-change, constants, cron, net, push-token, divergence, mirror-commit]
config:
  read: [schedule, mode, preserve, enabledWorkflows, disabledWorkflows]
  written: [schedule]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/schedule-args.test.ts, tests/unit/cron.test.ts, tests/unit/workflow.test.ts]
  integration: [tests/integration/schedule.test.ts, tests/integration/integrity.test.ts, tests/integration/config-change.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- `status` (the default) prints branch, enabled, cron and the workflow path. It only reads.
- `set <cron>` writes `schedule: { enabled: true, cron }` and re-stamps `origin/<default>` in the same step: upstream plus one managed commit that adds `.github/workflows/venfork-sync.yml`, pinned to `venfork@<this version>`.
- `disable` writes `enabled: false` and re-stamps origin without the workflow. With no preserve or workflow list, origin returns to the plain upstream tip.
- Order inside `set`/`disable`: read config at SHA S, refuse divergence, build the tip, write the config with a lease on S (no retry), push the tip with a lease. If the push fails, the config is restored to S.
- `set` warns that every upstream workflow can read `VENFORK_PUSH_TOKEN` while both workflow lists are empty, and prints the `gh secret set` command.
- Errors: "Invalid cron expression (expected 5 fields)", `SyncDivergenceError` (origin has user commits), `PinDowngradeError`, `GitError` "origin/main moved since this sync fetched it" (stale lease; the message says sync even here), `ConfigError` reason `conflict` (config moved between read and write), a combined error when the rollback also fails. Usage errors from the parser: "Missing cron expression", "Unknown schedule action".

## How a user reaches it

`venfork schedule`, `venfork schedule status`, `venfork schedule set "0 */6 * * *"`, `venfork schedule disable`. No prompt.

## How to drive it

```bash
venfork schedule set "0 */6 * * *" </dev/null 2>&1 | tail -1; echo $?     # 0
git -C "$VF_ORIGIN" show --stat --format=%s main                             # managed commit, workflow file
A=$(vf_tip "$VF_ORIGIN"); N=$(vf_pushes "$VF_ORIGIN")
venfork sync </dev/null >/dev/null 2>&1; echo "$A $(vf_tip "$VF_ORIGIN") $N $(vf_pushes "$VF_ORIGIN")"  # same SHA, same count
venfork schedule status </dev/null 2>&1 | grep -E "Enabled|Cron"
venfork schedule set "61 * * * *" </dev/null 2>&1 | grep Invalid             # exit 1
venfork schedule disable </dev/null 2>&1 | tail -1                           # origin back to upstream (+0)
vf_origin_commit src/hot.txt x; venfork schedule set "0 * * * *" </dev/null 2>&1 | tail -1  # exit 1, divergence
```

- Concurrent lease and rollback: after a `venfork sync`, make the stale copy (README) and copy the config into it (`git -C "$VF_ROOT/stale.git" fetch -q "$VF_ORIGIN" venfork-config:venfork-config`). Move the real origin with `vf_upstream_commit` + `venfork sync`, swap the fetch URL, run `venfork schedule set "30 * * * *"`. Exit 1, `venfork-config` on `$VF_ORIGIN` is back at its old SHA, `main` is unchanged.
- Cancel: there is no prompt, so there is no 130 path.

## What proves it

- `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` shows the `schedule` object.
- `git -C "$VF_ORIGIN" show main:.github/workflows/venfork-sync.yml | grep 'venfork@'` shows the pinned version.
- `vf_tip "$VF_ORIGIN" main^` equals `vf_tip "$VF_UPSTREAM"` after `set`. `vf_tip "$VF_ORIGIN"` equals it after `disable` (no other list active).
- `doctor --json`: `workflow` ok "up to date (venfork@..., cron '...')".

## What usually lies

- On the fixture `token`, `last-run` and `cron-age` are `skipped`. They do not prove the GitHub side.
- The managed SHA from `set` matches the one `sync` builds. A second SHA after `sync` means the two builders disagree.
- A repeat `set` with the same cron pushes nothing to `main` but still writes a new `venfork-config` commit. Count pushes on `main`, not on the config branch.
- `set` and `disable` never touch public. Only `sync` moves `public/main`.

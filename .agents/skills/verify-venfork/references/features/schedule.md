---
command: schedule
entry: src/commands/schedule.ts
shared: [config-change, constants, cron, json-output, net, push-token, divergence, mirror-commit]
config:
  read: [schedule, scheduleAuth, mode, publicForkUrl, preserve, enabledWorkflows, disabledWorkflows]
  written: [schedule, scheduleAuth]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/schedule-args.test.ts, tests/unit/cron.test.ts, tests/unit/workflow.test.ts, tests/unit/json-output.test.ts]
  integration: [tests/integration/cli.test.ts, tests/integration/schedule.test.ts, tests/integration/integrity.test.ts, tests/integration/config-change.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- `status` (the default) prints branch, enabled, cron, the workflow path and the auth mode. It reads, apart from `git fetch upstream`.
- `set <cron>` writes `schedule: { enabled: true, cron }` and re-stamps `origin/<default>` in the same step: upstream plus one managed commit that adds `.github/workflows/venfork-sync.yml`, pinned to `venfork@<this version>`.
- `disable` writes `enabled: false` and re-stamps origin without the workflow. With no preserve or workflow list, origin returns to the plain upstream tip.
- Order inside `set`/`disable`: read config at SHA S, refuse divergence, build the tip, write the config with a lease on S (no retry), push the tip with a lease. If the push fails, the config is restored to S.
- Auth: `set --app` writes `scheduleAuth: 'app'`, and the workflow mints a one-hour push token from the `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` secrets. `set --token` removes `scheduleAuth` (token mode, secret `VENFORK_PUSH_TOKEN`). `set` with neither flag keeps the current mode, and `disable` keeps it for the next `set`. A change of mode prints the `gh secret delete` commands for the secrets the workflow no longer reads.
- `set` warns that every upstream workflow can read the secret (`VENFORK_PUSH_TOKEN`, or `VENFORK_APP_PRIVATE_KEY` in App mode) while both workflow lists are empty, and prints the `gh secret set` commands.
- Usage errors (exit 2, from the parser, so also outside a git repository): "Invalid cron expression '<cron>' (expected 5 fields)", "Missing cron expression", "Unknown schedule action", "--app and --token cannot be used together", "--app applies only to 'schedule set'" (also `--token`). Runtime errors (exit 1): `SyncDivergenceError` (origin has user commits), `PinDowngradeError`, `GitError` "origin/main moved since this sync fetched it" (stale lease; the message says sync even here), `ConfigError` reason `conflict` (config moved between read and write), `ConfigError` reason `missing` ("venfork-config branch not found or invalid"), `PreconditionError` (`set --app` with the public fork under another owner), `ConfigError` "GitHub App auth needs the public fork on GitHub" (`set --app` with a non-GitHub `publicForkUrl`, as on the fixture; nothing is written), a combined error when the rollback also fails, `NotInRepositoryError` outside a git repository.
- `--json` on every action prints one envelope line on stdout. `result` is the schedule after the action: `{ enabled, cron?, auth: 'token' | 'app' }`. `cron` is absent when none is stored; `disable` keeps the stored cron.

## How a user reaches it

`venfork schedule`, `venfork schedule status`, `venfork schedule set "0 */6 * * *"`, `venfork schedule set "0 */6 * * *" --app`, `venfork schedule set "0 */6 * * *" --token`, `venfork schedule disable`, each with optional `--json`. No prompt; `--no-input` is accepted and changes nothing.

## How to drive it

```bash
venfork schedule set "0 */6 * * *" </dev/null 2>&1 | grep "Scheduled sync enabled"
git -C "$VF_ORIGIN" show --stat --format=%s main                             # managed commit, workflow file
A=$(vf_tip "$VF_ORIGIN"); N=$(vf_pushes "$VF_ORIGIN")
venfork sync </dev/null >/dev/null 2>&1; echo "$A $(vf_tip "$VF_ORIGIN") $N $(vf_pushes "$VF_ORIGIN")"  # same SHA, same count
venfork schedule status </dev/null 2>&1 | grep -E "Enabled|Cron"
venfork schedule status --json </dev/null 2>/dev/null | jq -c .result          # {"enabled":true,"cron":"0 */6 * * *","auth":"token"}
venfork schedule set "61 * * * *" </dev/null 2>&1 | grep Invalid             # usage, exit 2
venfork schedule set "0 * * * *" --app --json </dev/null 2>/dev/null | jq -r .error.code   # config: the fixture public fork is not on GitHub, exit 1
venfork schedule disable </dev/null 2>&1 | grep "Scheduled sync disabled"   # origin back to upstream (+0)
vf_origin_commit src/hot.txt x; venfork schedule set "0 * * * *" </dev/null 2>&1 | grep "Sync aborted"  # divergence, exit 1
```

- Concurrent lease and rollback: after a `venfork sync`, make the stale copy (features/README.md) and copy the config into it (`git -C "$VF_ROOT/stale.git" fetch -q "$VF_ORIGIN" venfork-config:venfork-config`). Move the real origin with `vf_upstream_commit` + `venfork sync`, swap the fetch URL, run `venfork schedule set "30 * * * *"`. Exit 1, `venfork-config` on `$VF_ORIGIN` is back at its old SHA, `main` is unchanged.
- Cancel: there is no prompt, so there is no 130 path.

## What proves it

- `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` shows the `schedule` object.
- `git -C "$VF_ORIGIN" show main:.github/workflows/venfork-sync.yml | grep 'venfork@'` shows the pinned version.
- `vf_tip "$VF_ORIGIN" main^` equals `vf_tip "$VF_UPSTREAM"` after `set`. `vf_tip "$VF_ORIGIN"` equals it after `disable` (no other list active).
- `doctor --json`: `workflow` ok "up to date (venfork@..., cron '...')".

## What usually lies

- On the fixture `token`, `last-run` and `cron-age` are `skipped` with a schedule ("origin is not a GitHub repository"). They do not prove the GitHub side.
- App mode cannot be set on the fixture. `tests/unit/commands.test.ts` and `tests/integration/schedule.test.ts` cover it; the e2e dispatch tier runs the App variant only with `VENFORK_E2E_APP_CLIENT_ID` and `VENFORK_E2E_APP_PRIVATE_KEY`.
- The managed SHA from `set` matches the one `sync` builds. A second SHA after `sync` means the two builders disagree.
- A repeat `set` with the same cron pushes nothing to `main` but still writes a new `venfork-config` commit. Count pushes on `main`, not on the config branch.
- `set` and `disable` never touch public. Only `sync` moves `public/main`.

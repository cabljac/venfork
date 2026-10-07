---
command: doctor
entry: src/commands/doctor.ts
shared: [constants, cron, divergence, managed-commit, mirror-commit, net, push-token, semver]
config:
  read: [mode, upstreamUrl, publicForkUrl, schedule, preserve, invalidPreserve, shippedBranches, pulledPrs, shippedIssues, pulledIssues]
  written: []
tests:
  unit: [tests/unit/doctor.test.ts, tests/unit/doctor-args.test.ts, tests/unit/node-smoke.test.ts]
  integration: [tests/integration/doctor.test.ts, tests/integration/cli.test.ts, tests/integration/integrity.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Ten checks, always in this order: `repo`, `remotes`, `mode`, `invariant`, `divergence`, `preserve`, `workflow`, `token`, `last-run`, `cron-age`. Each is `{ id, ok: true | false | 'skipped', detail, fix? }`.
- `--json` prints only `{ "checks": [...], "links": {...} }`. `links` holds the four link maps, or `null` when the config is unreadable.
- Exit 1 when any check is `false`. `skipped` does not fail.
- It only reads, apart from `git fetch --multiple origin upstream [public]` and fetching `venfork-config`.
- `repo` false for a non-repo or a missing, invalid or unfetchable config marks every later check `skipped`. An invalid cron also fails `repo`, but the git checks still run. A failed remote fetch fails `remotes` and skips `invariant` to `workflow`.
- `invariant`: "upstream (+0)", "upstream + 1 managed commit", "N upstream commit(s) not synced yet" (still ok), or false for stacked managed commits ("Run `venfork sync` to fold") or real divergence.
- `preserve` runs the same tip builder as sync, so it fails where sync would.
- `workflow`: missing, stale, unpinned (pre-0.11) or pinned newer than this CLI.
- `token`, `last-run`, `cron-age` are `true` "schedule disabled" when no schedule is on. With a schedule they need gh and a GitHub origin, else `skipped`.
- No typed error escapes: every problem is a check row.

## How a user reaches it

`venfork doctor`, `venfork doctor --json`. Run inside the mirror clone. No prompt.

## How to drive it

```bash
venfork doctor --json > "$T/d0.json"; echo $?                                 # 0
venfork schedule set "0 * * * *" </dev/null >/dev/null 2>&1
venfork doctor --json | grep -A2 '"invariant"\|"workflow"\|"token"'          # +1 managed, up to date, skipped
venfork doctor --json > "$T/d1.json"; venfork doctor --json | diff - "$T/d1.json"   # stable: no output
vf_origin_commit src/hot.txt x; venfork doctor --json | grep -B1 '"ok": false'; echo $?   # invariant, divergence; 1
(cd "$VF_ROOT" && venfork doctor --json | head -8)                          # repo false: not a git repository
git remote set-url --push upstream "$VF_UPSTREAM"; venfork doctor --json | grep -A3 '"remotes"'   # push URL not DISABLE
git remote set-url --push upstream DISABLE
```

- Cancel: there is no prompt, so there is no 130 path.
- Concurrent lease: doctor pushes nothing. To see a broken fetch, rename `$VF_UPSTREAM` away and back.

## What proves it

- Exit code plus `jq '[.checks[] | select(.ok == false) | .id]'` on the JSON.
- `jq '.checks | length'` is 10 in every state.
- After a doctor run, `vf_pushes "$VF_ORIGIN"` and `vf_tip "$VF_ORIGIN" venfork-config` are unchanged.

## What usually lies

- `tests/unit/doctor.test.ts` string-mocks gh for `token`, `last-run`, `cron-age`. Those three are not proven by any local drive.
- A green doctor on the fixture says nothing about GitHub secrets or Actions runs.
- The text table marks `skipped` with `-`, which is easy to read as a pass. Use `--json`.

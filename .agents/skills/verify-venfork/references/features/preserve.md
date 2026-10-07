---
command: preserve
entry: src/commands/preserve.ts
shared: [config-change, divergence, managed-commit, mirror-commit, net, preserve-entries]
config:
  read: [preserve, invalidPreserve]
  written: [preserve]
tests:
  unit: [tests/unit/preserve-args.test.ts, tests/unit/preserve-path.test.ts, tests/unit/config.test.ts]
  integration: [tests/integration/preserve-concurrency.test.ts, tests/integration/integrity.test.ts, tests/integration/config.test.ts, tests/integration/stage-gate-followups.test.ts, tests/integration/sync.test.ts, tests/integration/tip-builder.test.ts, tests/integration/doctor.test.ts]
  e2e: []
---

## What exists

- `list` (the default) prints the entries, plus invalid entries with the `venfork preserve remove '<entry>'` hint.
- `add <path>...` normalizes each path, then checks it is a file (regular, executable or symlink) on `origin/<default>`. It writes only the config. The next `sync` puts the file into the managed commit.
- `remove <path>...` and `clear` drop entries. When origin's tip managed commit carries a dropped file, origin is re-stamped in the same step. When user commits sit on top of that managed commit, only the config is written and a warning says sync drops the file later.
- Config writes are deltas with a leased push and up to 3 retries, so two crossing adds keep both entries.
- Errors: "Invalid preserve path" (leading `/` or `-`, `..`, `.`, backslash, whitespace, glob `* ? [ ]`, the sync workflow, `.venfork/`), "Cannot preserve '<p>': it does not exist on origin/main", "it is a directory", "Not in the preserve list" (remove of an unknown entry; nothing is written), `SyncDivergenceError` and `GitError` from the re-stamp.
- Sync rules that preserve sets up: upstream wins when it adds the same path; an entry that is a directory or glob makes sync and stage refuse (`ConfigError`).

## How a user reaches it

`venfork preserve`, `venfork preserve list`, `venfork preserve add <path>...`, `venfork preserve remove <path>...`, `venfork preserve clear`. A path that starts with `-` goes after `--`. No prompt.

## How to drive it

```bash
vf_origin_commit docs/INTERNAL.md "internal plan"                 # mirror-only file
venfork sync </dev/null 2>&1 | tail -1                             # exit 1: divergence on docs/INTERNAL.md
venfork preserve add docs/INTERNAL.md </dev/null 2>&1 | tail -1    # exit 0
venfork sync </dev/null >/dev/null 2>&1; git -C "$VF_ORIGIN" show --stat --format=%s main   # managed commit carries it
N=$(vf_pushes "$VF_ORIGIN"); venfork sync </dev/null >/dev/null 2>&1; echo "$N $(vf_pushes "$VF_ORIGIN")"   # equal
venfork preserve add src </dev/null 2>&1 | grep -o "Cannot preserve.*"       # directory, exit 1
venfork preserve add 'src/*.txt' </dev/null 2>&1 | grep -o "Invalid preserve path '[^']*'"
venfork preserve add docs/none.md </dev/null 2>&1 | grep -o "Cannot preserve.*"
venfork preserve remove src/nothere </dev/null 2>&1 | grep -o "Not in the preserve list.*"
venfork preserve remove docs/INTERNAL.md </dev/null >/dev/null 2>&1; git -C "$VF_ORIGIN" ls-tree -r --name-only main | grep -c INTERNAL   # 0
```

- Upstream takes the path over: see `multi-command-journeys.md` journey 3.
- Concurrent lease: two crossing writes need a hook between read and write. `tests/integration/preserve-concurrency.test.ts` pins it; there is no CLI drive.
- Cancel: there is no prompt, so there is no 130 path.

## What proves it

- `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` has the `preserve` array.
- `git -C "$VF_ORIGIN" show main:docs/INTERNAL.md` after sync. `git -C "$VF_PUBLIC" ls-tree -r --name-only main | grep -c INTERNAL` is 0.
- `doctor --json`: `preserve` ok "1 preserved path(s) restorable on the next sync".

## What usually lies

- `add` succeeding proves only the config. Nothing is on the managed commit until `sync`.
- `remove` re-stamps origin only when the tip managed commit carries the file. With a file now owned by upstream, it writes config only. Check `vf_pushes`.
- `tests/harness/preserve.ts` `seedPreserve` writes the list without the file check. A test that uses it does not prove `add`.

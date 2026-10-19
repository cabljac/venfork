---
command: approval
entry: src/commands/approval.ts
shared: [json-output]
config:
  read: [approval]
  written: [approval]
tests:
  unit: [tests/unit/stage-args.test.ts, tests/unit/config.test.ts]
  integration: [tests/integration/approval.test.ts]
  e2e: []
---

## What exists

- `venfork stage approval` prints the mirror's `approval` level from venfork-config: `off` (field absent), `reviewed` or `two-person`. `off` also prints the warning `The approval gate is off: ...`.
- `venfork stage approval <on|reviewed|two-person|off>` writes the level with a leased config push. `on` is `two-person`. `off` deletes the field and prints the same warning.
- Any other stored value (a level from a newer venfork, or a non-string) is kept on read and by every other config write, and refused by `approvalOf` with `ConfigError` (it suggests `venfork stage approval two-person`), so an older CLI never treats it as `off`. Only `"off"` and `""` read as off.
- Usage errors (exit 2): an unknown level (the message names the explicit form `stage branch approval`), a second level, and any branch flag (`--draft`, `--title`, `--dry-run`, `--pr`, ...); the branch-flag message also names `stage branch approval`. `stage approval` needs no gh.
- `--json`: `result` is `{ level }` after the action.

## How a user reaches it

`venfork stage approval [on|reviewed|two-person|off] [--json]`. A branch named `approval` needs the explicit form `stage branch approval` (see `stage.md`). No prompt.

## How to drive it

```bash
venfork stage approval --json </dev/null 2>/dev/null | jq -c .result          # {"level":"off"}
venfork stage approval on </dev/null 2>&1 | grep -o "Approval set to two-person"
git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json | jq -r .approval   # two-person
venfork stage approval off </dev/null 2>&1 | grep -o "The approval gate is off"
venfork stage approval maybe </dev/null; echo $?                                # 2
```

## What proves it

- `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` has `"approval"` after `on`/`reviewed`, and none after `off`.

## What usually lies

- The setting alone proves nothing about stage. Check the stage feature file for what stage does with the level.

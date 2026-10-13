---
command: workflows
entry: src/commands/workflows.ts
shared: [mirror-commit, managed-commit]
config:
  read: [enabledWorkflows, disabledWorkflows]
  written: [enabledWorkflows, disabledWorkflows]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/workflows-args.test.ts]
  integration: [tests/integration/tip-builder.test.ts, tests/integration/integrity.test.ts]
  e2e: []
---

## What exists

- `status` (the default) prints both lists and the precedence note, or "No workflow policy configured".
- `allow` / `unallow` add to or remove from `enabledWorkflows`. `block` / `unblock` do the same for `disabledWorkflows`. `clear` deletes both.
- Entries are reduced to basenames (`a/ci.yml` becomes `ci.yml`), trimmed, de-duplicated and sorted. Comma lists split: `block a.yml,b.yml`.
- The command writes only `venfork-config` (leased, up to 3 retries). It never moves `main`. The next `sync` applies it.
- In the managed commit, a non-empty allow list wins: only listed top-level `.github/workflows/*.yml|yaml` files stay. Else blocked basenames are removed. Subdirectories and the sync workflow are never removed.
- A non-empty list alone is enough to put a managed commit on origin, with no schedule or preserve list.
- Errors: usage errors only ("Usage: venfork workflows allow <workflow-file> ..."), and "venfork-config branch not found or invalid". Removing a name that is not listed succeeds silently.

## How a user reaches it

`venfork workflows`, `venfork workflows status`, `venfork workflows allow ci.yml lint.yml`, `venfork workflows block deploy.yml`, `venfork workflows unallow|unblock <file>...`, `venfork workflows clear`. No prompt.

## How to drive it

```bash
vf_upstream_commit .github/workflows/ci.yml "name: ci"; vf_upstream_commit .github/workflows/lint.yml "name: lint"
venfork sync </dev/null >/dev/null 2>&1
C=$(vf_tip "$VF_ORIGIN"); venfork workflows block ci.yml </dev/null >/dev/null 2>&1; [ "$C" = "$(vf_tip "$VF_ORIGIN")" ] && echo "main not moved"
venfork sync </dev/null >/dev/null 2>&1; git -C "$VF_ORIGIN" show --stat --format=%s main   # managed commit deletes ci.yml
N=$(vf_pushes "$VF_ORIGIN"); venfork sync </dev/null >/dev/null 2>&1; echo "$N $(vf_pushes "$VF_ORIGIN")"   # equal
venfork workflows allow lint.yml </dev/null >/dev/null 2>&1; venfork sync </dev/null >/dev/null 2>&1
git -C "$VF_ORIGIN" ls-tree --name-only main .github/workflows/                          # lint.yml only
venfork workflows clear </dev/null >/dev/null 2>&1; venfork sync </dev/null >/dev/null 2>&1   # origin == upstream (+0)
venfork workflows allow </dev/null 2>&1 | head -1                                         # exit 1, usage
```

- Cancel: there is no prompt, so there is no 130 path.
- Concurrent lease: config-only; covered by the `updateVenforkConfig` retry, with no CLI drive.

## What proves it

- `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` shows the lists.
- `git -C "$VF_ORIGIN" ls-tree --name-only main .github/workflows/` after sync.
- `git -C "$VF_PUBLIC" ls-tree --name-only main .github/workflows/` still lists every upstream workflow.

## What usually lies

- The command prints "Workflow policy updated" while `main` has not changed. Only `sync` proves the filter.
- Matching is by exact basename, not glob. `block 'ci*.yml'` blocks a file literally named `ci*.yml`.

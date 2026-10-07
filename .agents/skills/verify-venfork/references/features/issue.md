---
command: stage issue, pull issue
entry: src/commands/issue.ts
shared: [args, confirm, deny-list, redaction, repo]
config:
  read: []
  written: [shippedIssues, pulledIssues]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/stage-args.test.ts, tests/unit/pull-args.test.ts, tests/unit/redaction.test.ts]
  integration: [tests/integration/cli.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- One module, two directions. Both need gh auth (`AuthenticationError`) and resolve `upstream` (`RemoteNotFoundError`, "Could not parse upstream remote URL") and the mirror `owner/name` from `origin` (`RemoteNotFoundError('origin')`).
- The issue argument is a positive integer or a same-repo issue URL; a URL for another repo is refused.
- `stage issue <internal-#>`: `gh issue view` on the mirror, redact title and body with `stripInternalBlocks` (`RedactionError` on an unmatched close marker or a stray venfork comment), then `assertNoMirrorReference` on both (`MirrorReferenceError`). Preview, confirm "Open the issue on <upstream>?", `gh issue create` upstream, write `shippedIssues[<internal-#>]`.
- `pull issue <upstream-#>`: reads the upstream issue and its comments, builds `[upstream #N] <title>` and a body with an "Upstream comments" section, confirm, `gh issue create` on the mirror, write `pulledIssues[<new internal-#>]`.
- `VENFORK_NONINTERACTIVE=1` answers both confirms yes. A "no" exits 0; a cancel or EOF exits 130.
- One-shot: no later comment or state sync. A failed config write only warns.
- `stage issue` with a branch-only flag (`--pr`, `--draft`, `--base`, `--internal-pr`, `--no-update-existing`) is a parser error. Bare `stage issue` points at `venfork stage branch issue`. The old `venfork issue ...` exits 1 and names both new forms.

## How a user reaches it

`venfork stage issue <n-or-url> [--title <t>]`, `venfork pull issue <n-or-url> [--title <t>]`.

## How to drive it

Success needs real GitHub (e2e tier 5). On the fixture:

```bash
venfork stage issue 1 </dev/null 2>&1 | grep -o "Could not parse upstream remote URL"   # exit 1
venfork pull issue 1 </dev/null 2>&1 | grep -o "Could not parse upstream remote URL"    # exit 1
venfork stage issue </dev/null 2>&1                                                    # names `venfork stage branch issue`
venfork stage issue 1 --pr </dev/null 2>&1                                             # "--pr only applies to stage branch"
venfork issue stage 1 </dev/null 2>&1                                                  # rename hint, exit 1
```

- Redaction without GitHub: `bun -e "import { stripInternalBlocks } from './src/shared/redaction.ts'; console.log(stripInternalBlocks('pub <!-- venfork:internal -->secret<!-- /venfork:internal --> end'))"` prints `pub  end`. A body with `<!-- venfork:intenral -->` throws `RedactionError`.
- Already current, cancel at the confirm and the config lease are not reachable on the fixture; the remote check fails first.

## What proves it

- e2e only: `gh issue view <n> --repo <upstream> --json body` has no `venfork` and no internal block text.
- `git -C <mirror clone> show origin/venfork-config:.venfork/config.json` has `shippedIssues` / `pulledIssues`.
- `venfork doctor --json | jq .links`.

## What usually lies

- `issueCommand` unit tests mock every gh call. They prove the body text, not that gh accepted it.
- The confirm preview shows the redacted body. Text outside the markers that is still internal goes upstream; no gate catches it.

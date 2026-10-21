---
command: stage issue, pull issue
entry: src/commands/issue.ts
shared: [args, prompt, deny-list, json-output, redaction, repo, upstream-publish]
config:
  read: []
  written: [shippedIssues, pulledIssues]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/stage-args.test.ts, tests/unit/pull-args.test.ts, tests/unit/redaction.test.ts, tests/unit/json-output.test.ts, tests/unit/prompt.test.ts]
  integration: [tests/integration/cli.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- One module, two directions. Both need gh auth (`AuthenticationError`) and resolve `upstream` (`RemoteNotFoundError`, "Could not parse upstream remote URL") and the mirror `owner/name` from `origin` (`RemoteNotFoundError('origin')`).
- The issue argument is a positive integer or a same-repo issue URL; a URL for another repo is refused.
- `stage issue <internal-#>`: `gh issue view` on the mirror, redact title and body with `stripInternalBlocks` (`RedactionError` on an unmatched close marker or a stray venfork comment), then `assertNoMirrorReference` on both (`MirrorReferenceError`). Preview, confirm "Open the issue on <upstream>?", `gh issue create` upstream, write `shippedIssues[<internal-#>]`.
- `pull issue <upstream-#>`: reads the upstream issue and its comments, builds `[upstream #N] <title>` and a body with an "Upstream comments" section, confirm, `gh issue create` on the mirror, write `pulledIssues[<new internal-#>]`.
- `--yes` answers both confirms. Unless stdin and stderr are both a TTY, and with `CI` set, with `VENFORK_NONINTERACTIVE=1` or with `--no-input`, a confirm without `--yes` exits 2 naming `--yes` (`MissingInputError`) before it reads the issue, and opens nothing. At a TTY a "no" exits 0; a cancel or EOF exits 130.
- `--json` never prompts (it implies `--no-input`); without `--yes` it is the `missing-input` envelope, exit 2. On success `result` is `{ number, url, source: { number, url } }`: the issue venfork opened and the issue it came from.
- One-shot: no later comment or state sync. A failed config write only warns.
- `stage issue` with a branch-only flag (`--pr`, `--no-pr`, `--draft`, `--dry-run`, `--base`, `--internal-pr`, `--no-update-existing`, `--force`) is a usage error (exit 2). Bare `stage issue` points at `venfork stage branch issue` (exit 2). A malformed `<number-or-url>` exits 2; a URL to another repo exits 1. The old `venfork issue ...` exits 2 and names both new forms.

## How a user reaches it

`venfork stage issue <n-or-url> [--title <t>] [--yes] [--no-input] [--json]`, `venfork pull issue <n-or-url> [--title <t>] [--yes] [--no-input] [--json]`. `pull pr` never prompts: it accepts `--no-input`, `--yes` and `-y`, and they change nothing.

## How to drive it

Success needs real GitHub (e2e tier 5). On the fixture:

```bash
venfork stage issue 1 </dev/null 2>&1 | grep -o "Could not parse upstream remote URL"   # exit 1
venfork pull issue 1 </dev/null 2>&1 | grep -o "Could not parse upstream remote URL"    # exit 1
venfork stage issue </dev/null 2>&1                                                    # names `venfork stage branch issue`
venfork stage issue 1 --pr </dev/null 2>&1                                             # "--pr only applies to stage branch"
venfork stage issue 1 --json </dev/null 2>/dev/null | jq -c .error                    # code internal (upstream URL), exit 1
venfork issue stage 1 </dev/null 2>&1                                                  # rename hint, exit 2
```

- Redaction without GitHub: `(cd "$(dirname "$VF_CLI")/.." && bun -e "import { stripInternalBlocks } from './src/shared/redaction.ts'; console.log(stripInternalBlocks('pub <!-- venfork:internal -->secret<!-- /venfork:internal --> end'))")` prints `pub  end`. A body with `<!-- venfork:intenral -->` throws `RedactionError`.
- Already current, cancel at the confirm, the exit-2 confirm and the config lease are not reachable on the fixture; the remote check fails first. `tests/unit/commands.test.ts` pins `--yes` and the exit-2 path.

## What proves it

- e2e only: `gh issue view <n> --repo <upstream> --json body` has no `venfork` and no internal block text.
- `git -C <mirror clone> show origin/venfork-config:.venfork/config.json` has `shippedIssues` / `pulledIssues`.
- `venfork doctor --json | jq .result.links`.

## What usually lies

- `issueCommand` unit tests mock every gh call. They prove the body text, not that gh accepted it.
- The confirm preview shows the redacted body. Text outside the markers that is still internal goes upstream; no gate catches it.

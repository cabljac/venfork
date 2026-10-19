# Output streams and JSON

What goes to stdout and stderr, and the `--json` envelope, result shapes and error codes.

## Output Streams

venfork keeps stdout for results and sends everything a human reads to stderr:

- **stdout** carries only results: `venfork --version`, help you ask for (`venfork help`, `venfork help env`, `venfork help exit-codes`, `venfork <command> --help`) and the `--json` envelope.
- **stderr** carries progress, spinners, prompts, warnings, errors, usage printed for a bad command line (including bare `venfork` with no command), the human-readable reports of `doctor`, `schedule status`, `workflows status` and `keep list`, and the output of git and gh subprocesses.

So `venfork doctor --json > health.json` writes clean JSON while progress still shows in the terminal, and `venfork sync 2>sync.log` keeps stdout empty.

When stderr is a terminal, venfork draws styled output with colors and spinners. When stderr is not a terminal (a pipe, a file, CI), `NO_COLOR` is set to a non-empty value, or `TERM` is `dumb`, it prints plain lines with no ANSI escape codes and no spinner animation. Each line starts with a level prefix: `info:`, `ok:`, `step:`, `warn:`, `error:`. A spinner prints one `step:` line when it starts and one `done:` (or `error:`) line when it stops.

## JSON output

Every command accepts `--json`: `setup`, `clone`, `sync`, `schedule`, `stage` (branch, `stage issue` and `stage approval`), `pull pr`, `pull issue`, `doctor`, `workflows` and `keep`, with every action of `schedule`, `workflows` and `keep`. With it, stdout gets exactly one JSON object on one line, followed by a newline, also when the command fails. Progress, warnings and errors still go to stderr as usual. The exit code still follows the [exit codes](headless.md#non-interactive-use) table.

`--json` implies `--no-input`: venfork never prompts, even at a terminal. A confirm without `--yes` gives a `missing-input` error and exit 2, and so does a value that only a prompt could give (for example `setup` without `<upstream>`, or `clone` of a legacy mirror without `--public-fork`).

```json
{ "schemaVersion": 1, "ok": true, "result": { } }
{ "schemaVersion": 1, "ok": false, "error": { "code": "missing-input", "message": "...", "flag": "--yes" } }
{ "schemaVersion": 1, "ok": false, "error": { "code": "branch-not-found", "message": "...", "hint": "Run `git branch` to list local branches.", "details": { "branch": "feat" } } }
```

An error can carry `hint`, the next step (often a command to run), and `details`, facts a script can act on. Without `--json`, the hint prints after the message on the same line. `details` per code: `branch-not-found` `{ branch }`; `sync-divergence` `{ branch, origin: { count, files }, public: { count, files }, command? }`, where `command` is the `venfork keep add <files>` that keeps origin's files, each path single-quoted, present only when 1 to 10 of the files can be preserved (`origin.files` always lists every file); `precondition` for a preserved file sync cannot restore `{ path, command }`, where `command` is the `venfork keep remove` for it; `precondition` for a refused `pull pr` refresh `{ branch, ref, commits }`, where `ref` is the local branch or its `origin/` copy and `commits` counts the commits on it that the PR does not have; `stage-leak` `{ branch, paths, leak: "path" | "content", commit? }`; `mirror-reference` `{ where, matched }`; `redaction` `{ snippet }`; `remote-not-found` `{ remote }`; `config` `{ reason }`; `pin-downgrade` `{ pinned, running }`; `missing-input` `{ flag, question }`; `approval` `{ reason, level, prUrl?, headSha?, reviewers?, checks?, branchHead?, base?, defaultBranch?, headRef?, headRepo?, prNumbers? }`, where `reason` is `no-mirror-pr`, `wrong-head` (the `--internal-pr` PR is for another branch or its head is not on the mirror), `wrong-base` (the PR targets a branch other than the mirror default branch), `ambiguous-pr` (several open PRs for the branch target the default branch; `prNumbers` lists them), `branch-moved`, `changes-requested`, `not-approved`, `self-approved`, `checks-pending`, `checks-failed` or `gate-weakened` (a level lower than the one this clone last saw, which a person must confirm at a terminal; `details.weakened` is `{ from, to, unreadable? }`).

`schemaVersion` changes only when a field is removed or changes meaning. New fields can be added in the same version.

Any command line that contains `--json` before any `--` gets the envelope, whatever the command: a usage error, an unknown or renamed command or `--json` before the command (`venfork --json sync`) prints the error envelope with code `usage` and exit 2. Help and `--version` print text, so `--json` with `help`, `-h`, `--help` or `--version` is also a usage error. A SIGINT prints the `cancelled` envelope and exits 130; a SIGTERM prints it and exits 143.

**Error codes** (`error.code`):

| Code | Meaning |
| --- | --- |
| `usage` | Bad command line (exit 2) |
| `missing-input` | venfork could not prompt and no flag gave the answer; `error.flag` names the flag (exit 2) |
| `cancelled` | Cancelled or interrupted (exit 130, or 143 for SIGTERM) |
| `auth` | gh is not authenticated, or not installed (the message says which) |
| `git` | A git operation failed, for example a rejected push |
| `github` | A gh call to GitHub failed, for example creating a fork or repo, reading an issue or opening a PR; the message is gh's error |
| `precondition` | The state on GitHub, on disk or in `venfork-config` does not allow the action, for example an existing directory, a repo that is not the expected fork, a flag that contradicts the recorded layout, a path that is not in the preserve list, or staging upstream's default branch |
| `remote-not-found` | A required remote (`origin`, `public`, `upstream`) is missing |
| `not-in-repository` | A command that runs in a mirror (`sync`, `stage`, `pull`, `schedule`, `workflows`, `keep`) was run outside a git repository |
| `branch-not-found` | The branch does not exist |
| `sync-divergence` | Sync stopped: origin or public has commits upstream does not have |
| `config` | The `venfork-config` branch is missing, cannot be read, is invalid, or moved during a write |
| `redaction` | A title or body mentions venfork outside a well-formed internal block |
| `mirror-reference` | Text bound for upstream points back at the private mirror |
| `stage-leak` | Stage would publish a mirror-only path or its content, or it cannot check the mirror history (too many reflog entries or commits, a directory where venfork writes a file, a file over 100 MB). Text that names the mirror is `mirror-reference`, and a bad internal block is `redaction` |
| `approval` | Stage stopped: the mirror's approval level is not met for the branch (no open mirror PR, no counting approval on its head, changes requested, checks pending or failed, or the branch moved past the approved head) |
| `pin-downgrade` | origin pins a newer venfork than the one running |
| `unmigrated-mirror` | The mirror's sync workflow predates venfork 0.11 |
| `runtime` | Another venfork runtime failure |
| `internal` | An unexpected error that venfork did not classify |

**Results** (`result`), per command:

- `sync` on the default branch: `{ "kind": "default-branch", "status": "pushed" | "up-to-date", "branch", "upstreamTip", "origin": { "tip", "pushed" }, "public"?: { "tip", "pushed" } }`. `public` is absent in no-public mode. `status` is `pushed` when origin or public moved.
- `pull pr`: `{ "branch", "head", "prNumber", "prUrl", "pushed", "refreshed" }`. `refreshed` is true when this PR's copy already existed (the local branch, the mirror copy or a matching `pulledPrs` record), also when its head did not move. `pushed` is false with `--no-push` or a failed push; a failed push exits 1, with or without `--json`.
- `stage <branch>`: `{ "branch", "head", "target": "public" | "upstream", "compareUrl", "prAction"?, "prUrl"?, "internalPrUrl"? }`. `head` is the rebuilt commit that was pushed. `prAction` is present unless `--no-pr`: `created`, `updated` (an open PR's body was refreshed), `unchanged` (an open PR was left as is) or `failed` (the push worked, the PR could not be opened or its body could not be updated; the run exits 1). `approval` is present when the mirror's approval level is not `off`: `{ "level", "ok": true, "prUrl", "headSha", "approvers" }`.
- `stage <branch> --dry-run`: `{ "dryRun": true, "branch", "head", "target", "compareUrl", "base", "commits", "files", "removedLater", "prTitle"?, "prBody"?, "existingPrUrl"?, "internalPrUrl"? }`. Nothing was pushed: `head` is the preview rebuild's local commit (a real stage rebuilds again, so its SHA differs but its tree is the same), `commits` are its subjects oldest first, and `prTitle`/`prBody` are the redacted PR text that a real stage would publish (absent with `--no-pr`). `existingPrUrl` is the open upstream PR a real stage would update; with it, `prTitle` is absent (the title stays), and with `--no-update-existing` `prBody` is absent too. `approval` is present when the level is not `off`: on a pass as for a real stage, else `{ "level", "ok": false, "reason", "message", "prUrl"? }`, where `reason` is an `approval` error reason or `precondition`. `weakened` is the lowered approval level a real stage would ask a person to confirm: `{ "from", "to", "unreadable"? }`, where `from` is the level this clone last saw and `unreadable` is true when the clone memory could not be read (then `from` is `two-person`).
- `stage approval` (with or without a level): `{ "level": "off" | "reviewed" | "two-person" }`, the level after the action.
- `stage issue` and `pull issue`: `{ "number", "url", "source": { "number", "url" } }`. `number` and `url` are the issue venfork opened; `source` is the issue it was made from.
- `doctor`: `{ "checks": [{ "id", "ok": true | false | "skipped", "detail", "fix"? }], "links": { "shippedBranches", "pulledPrs", "shippedIssues", "pulledIssues" } | null, "healthy" }`. `healthy` is false when any check failed. Doctor that ran is `ok: true` even when a check failed; it then exits 1.
- `setup`: `{ "mode": "standard" | "no-public", "mirror": { "repo", "url" }, "publicFork"?: { "repo", "url" }, "upstream": { "repo", "url" }, "directory" }`. `repo` is `owner/name` and `url` its `https://github.com/` page. `publicFork` is absent in no-public mode. `directory` is the absolute path of the local mirror checkout.
- `clone`: `{ "mode": "standard" | "no-public", "directory", "remotes": { "origin", "public"?, "upstream" } }`. `remotes` holds each remote's fetch URL; `public` is absent in no-public mode.
- `schedule` (every action): `{ "enabled", "cron"?, "auth": "token" | "app" }`, the schedule after the action. `cron` is absent when none is stored; `disable` keeps the stored cron.
- `workflows` (every action): `{ "mode": "allow" | "block" | "none", "enabledWorkflows", "disabledWorkflows" }`, the policy after the action. `mode` is `allow` when the allowlist is set (it wins over the block list), `block` when only the block list is set.
- `keep` (every action): `{ "paths", "invalidPaths" }`, the list after the action. `invalidPaths` are entries sync refuses to run with until they are removed.

```bash
venfork sync --json | jq -r '.result.status'
venfork stage feat/auth --yes --json | jq -r '.result.prUrl'
```

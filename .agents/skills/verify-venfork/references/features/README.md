# Feature map

One file per `src/commands/<name>.ts`. Open only the file for the command you changed.

| File | CLI | Needs GitHub for success |
|---|---|---|
| `setup.md` | `venfork setup` | yes |
| `clone.md` | `venfork clone` | yes |
| `sync.md` | `venfork sync [branch]` | no |
| `schedule.md` | `venfork schedule` | no |
| `stage.md` | `venfork stage [branch] <name>` | only with `--pr` |
| `pull-request.md` | `venfork pull pr` | yes (`sync upstream-pr/<n>` does not) |
| `issue.md` | `venfork stage issue`, `venfork pull issue` | yes |
| `doctor.md` | `venfork doctor` | no (`transport` skips for a non-GitHub origin; `token`, `last-run`, `cron-age` need a schedule, gh and a GitHub origin) |
| `workflows.md` | `venfork workflows` | no |
| `preserve.md` | `venfork preserve` | no |
| `help.md` | `venfork help`, `--help`, `--version`, bare `venfork` | no |

Cross-cutting: `leak-invariants.md` (what must never reach public or upstream), `multi-command-journeys.md`.

## Conventions in every file

- Every drive starts from `SKILL.md` Launch: `. "$T/vf.env"; cd "$VF_WORK"`. Default branch is `main`.
- `$VF_PUBLIC` is empty with `--no-public`. Stage then pushes to `$VF_UPSTREAM`.
- Exit codes: 0 success (and "no" at a confirm at a terminal), 1 a runtime failure (the message prints once, as `error: ...` or, on a TTY, after a red `■`, with no spinner `done:` line and no failed outro; `reportFailure` in `src/shared/ui.ts`), a failing `doctor` check (doctor prints no `error:` line; its summary outro counts the failed checks, e.g. `❌ 2 failed, 5 passed, 4 skipped`) or a partial success (`partialFailureExitCode` in `src/dispatch.ts`: stage `prAction: failed`, a failed `pull pr` or `sync <branch>` push to origin; the success envelope still holds the result), 2 a usage error (`UsageError`: unknown command or option, missing or unexpected argument, malformed flag value, flags that cannot be combined, bare `venfork`) or missing input or consent (`MissingInputError`), 130 a cancel or SIGINT, 143 a SIGTERM. Input valid in form that fails against the repos (a missing branch, divergence, a flag that contradicts `venfork-config`) is exit 1.
- Exit 130 has three causes: a prompt that is cancelled (Ctrl-C, Esc) or whose input ends (`Cancelled: input ended at a prompt`); a terminal that closes during the run (EIO on stdin, stdout or stderr, `src/shared/closed-output.ts`); a SIGINT (without `--json`, Node's default handler ends the run and the shell reports 130). Under `--json`, `src/index.ts` prints the `cancelled` envelope on a SIGINT (exit 130) or a SIGTERM (exit 143). Without `--json`, a SIGTERM is Node's default handler too and the shell reports 143. `setup` handles both signals itself: it removes its temp dir, then exits 130 for SIGINT or 143 for SIGTERM (`tests/integration/cli.test.ts` pins 143 for `sync --json` and `setup`). A reader that closes the pipe early (`venfork help | head -1`, EPIPE) keeps the exit code so far and prints no stack.
- Prompts: venfork prompts only when stdin and stderr are both a TTY (prompts render on stderr), `CI` is unset (or empty, `false`, `0`), `VENFORK_NONINTERACTIVE` is not `1` and there is no `--no-input` or `--json` (`canPrompt` in `src/shared/prompt.ts`). At a terminal, `venfork stage feat 2>/dev/null` exits 2 naming `--yes`; it does not wait on a hidden prompt (`tests/integration/cli.test.ts`, "stage with stderr redirected at a TTY"). Every command accepts `--no-input`, `--yes` and `-y`; where nothing prompts or confirms they are no-ops (`isPromptFlag` in `src/shared/args.ts`).
- Outside a git repository, `sync`, `stage`, `pull`, `schedule`, `workflows` and `preserve` stop before the command runs with `NotInRepositoryError` (code `not-in-repository`, exit 1; `assertInRepository` in `src/dispatch.ts`, called by `src/index.ts` after the arguments parse and gh auth). stderr holds only `error: Not in a git repository. ...`: no intro, spinner or command error. A usage error still exits 2, because every usage check runs in the parse step (the cron check in `parseScheduleCliArgs`, the `preserve add` path check in `src/index.ts`). `doctor` reports it as its `repo` check, and `setup` and `clone` run outside a repo.
- Typed errors live in `src/errors.ts`. Without `--json` the CLI prints only `.message`. With `--json`, match on `error.code`; it is stable, the message is not. The codes (`ErrorCode` in `src/errors.ts`; `describeError` in `src/shared/json-output.ts` maps a failed `git` or `gh` subprocess to `git` or `github`, else `internal`):
  - exit 2: `usage`, `missing-input` (with `error.flag`).
  - exit 130 or 143: `cancelled`. A declined confirm is `CommandExitError(0)`, also coded `cancelled`, but no envelope carries it: `--json` implies `--no-input`, so a JSON run never shows a confirm.
  - exit 1: `auth`, `git`, `github`, `precondition`, `remote-not-found`, `not-in-repository`, `branch-not-found`, `sync-divergence`, `config`, `redaction`, `mirror-reference`, `stage-leak`, `pin-downgrade`, `unmigrated-mirror`, `runtime`, `internal`. No envelope reports `command-failed`: a `CommandExitError` without a cause is `runtime` (exit 1), `usage` (exit 2) or `cancelled`.
  - `error.hint` (the next step) and `error.details` (files, paths, branch, flag) are present for the codes README "JSON output" lists; without `--json` the hint follows the message on the one `error:` line.
- Network ops: every git fetch, push and ls-remote runs through `netExec` (`src/shared/net.ts`): no stdin, a hard timeout, ssh `BatchMode`, and gh as the only credential helper for `https://github.com` (see `sync.md`).
- "Concurrent lease" drives use a stale copy of origin: fetch from the copy, push to the real origin.

```bash
git clone -q --bare "$VF_ORIGIN" "$VF_ROOT/stale.git"
# ... move the real origin on (vf_origin_commit or another venfork run) ...
git remote set-url origin "$VF_ROOT/stale.git"; git remote set-url --push origin "$VF_ORIGIN"
# drive, then restore:
git remote set-url origin "$VF_ORIGIN"; git config --unset-all remote.origin.pushurl
```

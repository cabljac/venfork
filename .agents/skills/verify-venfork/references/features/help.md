---
command: help
entry: src/commands/help.ts
shared: [constants, ui]
config:
  read: []
  written: []
tests:
  unit: [tests/unit/help.test.ts, tests/unit/docs-drift.test.ts, tests/unit/usage-errors.test.ts, tests/unit/json-output.test.ts]
  integration: [tests/integration/cli.test.ts]
  e2e: []
---

## What exists

- `venfork help`, `venfork --help` and `venfork -h` print the one-screen command list on stdout and exit 0: the intro, a "Commands" note with the groups Get started, Every day, Review upstream work, Automation and Advanced (one line per command), a two-line example, and an outro that names `venfork <command> --help`, `venfork help env` and `venfork help exit-codes`. Advanced says `--yes` and `--no-input` work on every command and that `stage --dry-run` pushes nothing. `tests/integration/cli.test.ts` runs the built CLI on a forced 80-column TTY (clack's box) and on a pipe, and checks that both fit 36 lines of 80 columns with no wrapped row. `tests/unit/help.test.ts` checks the plain form and refuses implementation terms in it.
- `venfork help env` prints the environment variables (`VENFORK_ALLOW_SELF_REFERENCE` under an Advanced heading) and `venfork help exit-codes` the exit-code table, on stdout, exit 0 (`helpTopic`). Both fit 80 columns. The test derives the env list from every `process.env.VENFORK_*` that `src/` reads. They are help topics, not commands: `venfork env --help` is the unknown-command usage error.
- `venfork help <command>` prints only that command's usage on stdout. `help pull pr`, `help pull issue` and `help stage issue` print the subcommand entry. `help version`, `help -v` and `help --version` print the `--version` entry. An unknown `<command>` (`help bogus`) is the unknown-command usage error (exit 2, nothing on stdout), and a renamed one (`help status`) names the new form, as `venfork bogus` and `venfork status` do.
- `venfork <command> --help` (or `-h`) prints that command's usage on stdout and exits 0. It is checked before the parser, so other bad arguments on the same line do not matter. `venfork bogus --help` has no entry and is the unknown-command usage error.
- `--yes`, `-y` and `--no-input` anywhere after `help` (`venfork help --yes`, `venfork help -y doctor`) are ignored, as on every command.
- Every usage line lists `[--yes] [--no-input] [--json]`, "Available Commands" ends with "Every command accepts --yes, -y and --no-input", and the "Exit Codes" row for 1 includes a partial success.
- `venfork --version`, `-v` and `version` print the package version on stdout and exit 0.
- Bare `venfork` prints the same one-screen list on stderr (stdout stays empty) and exits 2.
- Unknown command: exit 2, "Unknown command: <name>. Run `venfork help`.". Renamed commands exit 2 and name the new form: `pull-request` (`venfork pull pr`), `issue` (`venfork pull issue`, `venfork stage issue`), `status` (`venfork doctor`).
- `--json` with `help`, `-h`, `--help`, `--version`, `-v` or `version`, or with `-h`/`--help` after a command, is a usage error: the `usage` envelope on stdout, "--json cannot be combined with help or --version, which print text", exit 2. `--json` as the first word (`venfork --json sync`) is the `usage` envelope "Put --json after the command".
- A reader that closes the pipe early (`venfork help | head -1`) keeps exit 0 and prints no EPIPE stack.

## How a user reaches it

`venfork`, `venfork help [command [subcommand]]`, `venfork help env`, `venfork help exit-codes`, `venfork --help`, `venfork -h`, `venfork <command> --help`, `venfork --version`, `venfork -v`, `venfork version`. No prompt and no repo: it runs anywhere.

## How to drive it

```bash
venfork help >/dev/null 2>&1; echo $?                                   # 0
venfork help 2>/dev/null | grep -c -e "Get started" -e "Automation"   # 2
venfork help exit-codes 2>/dev/null | grep -c "^143 "                  # 1
venfork help sync 2>/dev/null | head -1                                 # venfork sync [--report-issues] [--no-input] [--json]
venfork help bogus 2>&1; echo $?                                        # Unknown command: bogus. ..., 2
venfork pull pr --help 2>/dev/null | head -1                            # venfork pull pr <pr-number-or-url> ...
venfork --version                                                       # the package.json version
venfork 2>/dev/null | wc -c; venfork >/dev/null 2>&1; echo $?          # 0, then 2
venfork help --json 2>/dev/null | jq -r .error.code; echo "${PIPESTATUS[0]}"  # usage, 2
venfork sync --help --json 2>/dev/null | jq -r .error.code              # usage
venfork --json sync 2>/dev/null | jq -r .error.message                  # Put --json after the command, ...
venfork bogus 2>&1; echo $?                                             # Unknown command: bogus. ..., 2
venfork status 2>&1; echo $?                                            # `venfork status` is now `venfork doctor`., 2
venfork help | head -1 >/dev/null; echo "${PIPESTATUS[0]}"              # 0
```

- Already current: help only reads; every run prints the same text.
- Cancel and concurrent lease: there is no prompt and no write, so there is no 130 path and no lease.

## What proves it

- Exit code, and which stream holds the text: `venfork help 2>/dev/null` is not empty, `venfork 2>/dev/null` is empty.
- With `--json`, stdout is one line and `jq -r .error.code` is `usage`.
- `tests/unit/docs-drift.test.ts` checks that every dispatched command has a README heading and that every flag and subcommand in a command's help usage appears in its README section.

## What usually lies

- The help text is code (`src/commands/help.ts`). A change to a parser does not update it; `tests/unit/help.test.ts` checks only a few entries against the parsers.
- `venfork help exit-codes` lists 0, 1 (including a partial success), 2, 130 (a cancelled prompt, input that ended at a prompt, SIGINT, or a closed terminal) and 143. Without `--json`, a SIGINT or SIGTERM is Node's default handler, so the shell reports 130 or 143 and the process prints nothing more (see `README.md` in this folder).

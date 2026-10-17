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

- `venfork help`, `venfork --help` and `venfork -h` print the full help on stdout and exit 0: the intro, "Available Commands" (every command's usage), "Example Workflow", "Environment Variables", "Exit Codes" and the outro.
- `venfork help <command>` prints only that command's usage on stdout. `help pull pr`, `help pull issue` and `help stage issue` print the subcommand entry. `help version`, `help -v` and `help --version` print the `--version` entry. An unknown `<command>` (`help bogus`) is the unknown-command usage error (exit 2, nothing on stdout), and a renamed one (`help status`) names the new form, as `venfork bogus` and `venfork status` do.
- `venfork <command> --help` (or `-h`) prints that command's usage on stdout and exits 0. It is checked before the parser, so other bad arguments on the same line do not matter. `venfork bogus --help` has no entry and is the unknown-command usage error.
- `venfork --version`, `-v` and `version` print the package version on stdout and exit 0.
- Bare `venfork` prints the full help on stderr (stdout stays empty) and exits 2.
- Unknown command: exit 2, "Unknown command: <name>. Run `venfork help`.". Renamed commands exit 2 and name the new form: `pull-request` (`venfork pull pr`), `issue` (`venfork pull issue`, `venfork stage issue`), `status` (`venfork doctor`).
- `--json` with `help`, `-h`, `--help`, `--version`, `-v` or `version`, or with `-h`/`--help` after a command, is a usage error: the `usage` envelope on stdout, "--json cannot be combined with help or --version, which print text", exit 2. `--json` as the first word (`venfork --json sync`) is the `usage` envelope "Put --json after the command".
- A reader that closes the pipe early (`venfork help | head -1`) keeps exit 0 and prints no EPIPE stack.

## How a user reaches it

`venfork`, `venfork help [command [subcommand]]`, `venfork --help`, `venfork -h`, `venfork <command> --help`, `venfork --version`, `venfork -v`, `venfork version`. No prompt and no repo: it runs anywhere.

## How to drive it

```bash
venfork help >/dev/null 2>&1; echo $?                                   # 0
venfork help 2>/dev/null | grep -c -e "Available Commands" -e "Exit Codes"   # 2
venfork help sync 2>/dev/null | head -1                                 # venfork sync [branch] [--report-issues] [--no-input] [--json]
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
- The "Exit Codes" section lists 0, 1, 2, 130 and 143. Without `--json`, a SIGINT or SIGTERM is Node's default handler, so the shell reports 130 or 143 and the process prints nothing more (see `README.md` in this folder).

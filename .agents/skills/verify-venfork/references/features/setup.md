---
command: setup
entry: src/commands/setup.ts
shared: [net, fs, json-output, prompt]
config:
  read: [mode, upstreamUrl, publicForkUrl]
  written: [version, mode, upstreamUrl, publicForkUrl]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/setup-args.test.ts, tests/unit/net.test.ts, tests/unit/json-output.test.ts, tests/unit/prompt.test.ts]
  integration: [tests/integration/cli.test.ts, tests/integration/integrity.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Needs gh auth first (`AuthenticationError`: "GitHub CLI is not authenticated. Please run: gh auth login").
- Prompts for the upstream when it is missing and for the mirror name when it is missing (default `<repo>-private`). With no `--org` and no `VENFORK_ORG`, asks "Continue with personal account?"; `--yes` answers it. `--org` set to your own gh username (any case) is consent: the repos go under the personal account (no `gh repo fork --org`) and the confirm is skipped, with or without a TTY. `VENFORK_ORG` set to your username is not consent: the repos still go under the personal account, but the confirm runs (exit 2 naming `--yes` when it cannot prompt).
- Never prompts unless stdin and stderr are both a TTY (prompts render on stderr), and never with `CI` set (not `false`/`0`), with `VENFORK_NONINTERACTIVE=1` or with `--no-input`. Then a missing mirror name becomes `<repo>-private` (logged on stderr), a missing upstream exits 2 naming "the <upstream> argument", and the personal-account confirm without `--yes` exits 2 naming `--yes` (`MissingInputError`). stdout stays empty.
- Standard mode: `gh repo fork` (public fork), `gh repo create --private` (mirror), seeds a new mirror from a temp clone of upstream in chunks (`VENFORK_SEED_CHUNK`, `VENFORK_SEED_RETRY_MS`) over HTTPS through `netExec`, so gh is the only github.com credential helper, `gh repo clone`s the mirror into `./<name>`, `gh repo set-default`.
- Writes the orphan `venfork-config` branch. Never overwrites one: an existing config that agrees is kept, one that disagrees is a `ConfigError` ("The existing venfork-config disagrees with this setup").
- Sets remotes: `origin`, `public` (not with `--no-public`; a stale `public` is removed), `upstream` with push URL `DISABLE`. URLs follow `gh config get git_protocol`.
- Recovery: when the fork or the mirror already exists on GitHub, setup skips the seed, reuses a matching local clone and runs `sync` quietly inside it.
- Usage errors (exit 2, before gh auth): `--no-public` with `--fork-name`, invalid upstream, invalid `--fork-name`. Runtime errors (exit 1): `PreconditionError` for upstream already under the owner without `--fork-name`, an existing repo that is not a fork of upstream, a local directory that is not the expected mirror clone; `GitHubError` (gh's own message) when `gh repo fork` or `gh repo create` fails and no usable repo exists.
- SIGINT and SIGTERM during the run: setup stops its spinner ("Setup interrupted"), removes its temp dir and exits 130 for SIGINT or 143 for SIGTERM (`CommandExitError`, code `cancelled`), with or without `--json`.
- `--json` implies `--no-input` and prints one envelope line on stdout. `result` is `{ mode, mirror: { repo, url }, publicFork?: { repo, url }, upstream: { repo, url }, directory }`: `repo` is `owner/name`, `url` the `https://github.com/` page, `publicFork` absent with `--no-public`, `directory` the absolute checkout path. Failures carry `error.code` (`missing-input` with `flag`, `usage`, `auth`, `precondition`, `github`, `config`, `cancelled`).

## How a user reaches it

`venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--no-public] [--yes] [--no-input] [--json]`. `<upstream>` is a GitHub URL or `owner/repo`.

## How to drive it

The success and recovery paths need real GitHub (e2e tier 1, opt-in). On the fixture, drive only the edges, from `$VF_ROOT`:

```bash
cd "$VF_ROOT"
venfork setup </dev/null 2>&1; echo $?                                 # 2, "Pass the <upstream> argument."
venfork setup a/b b-private </dev/null 2>&1; echo $?                   # 2, "Continue with personal account?" ... "Add --yes to confirm."
venfork setup a/b b-private --json </dev/null 2>/dev/null | jq -c '[.error.code, .error.flag]'   # ["missing-input","--yes"]
venfork setup a/b --org c </dev/null 2>&1 | grep -o "Private mirror repo name? b-private.*"   # default used, then exit 1 at gh
venfork setup a/b --no-public --fork-name x </dev/null 2>&1; echo $?   # 2, "--no-public cannot be combined with --fork-name"
venfork setup a/b m --fork-name "bad name" --org c </dev/null 2>&1 | grep -o "Invalid --fork-name"
venfork setup a/b m --org c </dev/null 2>&1 | grep "gh stub"           # exit 1 at the first gh call
cp "$VF_ROOT/bin/gh" "$VF_ROOT/gh.ok"; printf '#!/bin/sh\nexit 1\n' > "$VF_ROOT/bin/gh"
venfork setup a/b </dev/null 2>&1                                      # AuthenticationError, exit 1
mv "$VF_ROOT/gh.ok" "$VF_ROOT/bin/gh"
```

- Already current: re-running setup on existing repos is the recovery path. Unit tests in `setupCommand - idempotent recovery` cover it with string mocks; only e2e proves it.
- Concurrent lease: `createConfigBranch` refuses an existing branch (`tests/integration/integrity.test.ts`).

## What proves it

- e2e only: `gh repo view <owner>/<name>-private --json visibility`, `git -C <name>-private remote -v` (upstream push `DISABLE`), `git -C <name>-private show origin/venfork-config:.venfork/config.json`.
- `venfork doctor --json` inside the new clone: `remotes`, `mode` and `invariant` ok.
- On the fixture: exit code and message only. No repo is created.

## What usually lies

- `tests/unit/commands.test.ts` answers every `gh` call with a string. A green setup test does not show that GitHub accepted a fork, a create or a push.
- The fixture already contains what setup would build. It does not exercise setup.
- Exit 0 after "Continue with personal account?" answered no is a cancel, not a success.
- `VENFORK_NONINTERACTIVE=1` does not confirm. Only `--yes` does; without it the confirm exits 2.

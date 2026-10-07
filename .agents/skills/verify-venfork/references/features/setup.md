---
command: setup
entry: src/commands/setup.ts
shared: [net, fs]
config:
  read: [mode, upstreamUrl, publicForkUrl]
  written: [version, mode, upstreamUrl, publicForkUrl]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/setup-args.test.ts, tests/unit/net.test.ts]
  integration: [tests/integration/cli.test.ts, tests/integration/integrity.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Needs gh auth first (`AuthenticationError`: "GitHub CLI is not authenticated. Please run: gh auth login").
- Prompts for the upstream when it is missing and for the mirror name when it is missing (default `<repo>-private`). With no `--org` and no `VENFORK_ORG`, asks "Continue with personal account?". `VENFORK_NONINTERACTIVE` never answers that prompt.
- Standard mode: `gh repo fork` (public fork), `gh repo create --private` (mirror), seeds a new mirror from a temp clone of upstream in chunks (`VENFORK_SEED_CHUNK`, `VENFORK_SEED_RETRY_MS`), `gh repo clone`s the mirror into `./<name>`, `gh repo set-default`.
- Writes the orphan `venfork-config` branch. Never overwrites one: an existing config that agrees is kept, one that disagrees is a `ConfigError` ("The existing venfork-config disagrees with this setup").
- Sets remotes: `origin`, `public` (not with `--no-public`; a stale `public` is removed), `upstream` with push URL `DISABLE`. URLs follow `gh config get git_protocol`.
- Recovery: when the fork or the mirror already exists on GitHub, setup skips the seed, reuses a matching local clone and runs `sync` quietly inside it.
- Errors: `--no-public` with `--fork-name`, invalid upstream, invalid `--fork-name`, upstream already under the owner without `--fork-name`, an existing repo that is not a fork of upstream, a local directory that is not the expected mirror clone.

## How a user reaches it

`venfork setup <upstream> [name] [--org <org>] [--fork-name <repo>] [--no-public]`. `<upstream>` is a GitHub URL or `owner/repo`.

## How to drive it

The success and recovery paths need real GitHub (e2e tier 1, opt-in). On the fixture, drive only the edges, from `$VF_ROOT`:

```bash
cd "$VF_ROOT"
venfork setup </dev/null 2>&1 | tail -1; echo $?                       # 130, prompt hit EOF
venfork setup a/b --no-public --fork-name x </dev/null 2>&1 | tail -1   # exit 1, parser error
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

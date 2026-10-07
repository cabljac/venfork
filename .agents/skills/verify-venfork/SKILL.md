---
name: verify-venfork
description: Prove a venfork change works by driving the built CLI against local bare repos and reading git state, not test output.
---

# Verify venfork

Use this after you change a command, a shared helper or the managed-commit logic.
The proof is git state in local bare repos. It is not a green test run.

## Launch

```bash
bun run build
T=$(mktemp -d); bun scripts/verify-fixture.ts --shell > "$T/vf.env"
. "$T/vf.env"; cd "$VF_WORK"
```

- Without `--shell` the script prints JSON: `root`, `work`, `upstream`, `origin`, `publicFork`, `upstreamDev`, `originDev`, `cli`, `ghStubDir`, `env`.
- `--no-public` builds the two-remote layout. `--commits <n>` seeds more upstream commits.
- The sourced file sets `HOME`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `VF_*` paths, and a `gh` stub on `PATH`.
  The stub passes `gh auth status` and fails all else. No drive can reach GitHub.
- Helpers: `venfork`, `vf_tip <repo> [ref]`, `vf_pushes <repo> [ref]` (reflog count = accepted pushes),
  `vf_yes <args>` (answers one confirm through a pseudo-TTY), `vf_upstream_commit <path> <text> [msg]`,
  `vf_origin_commit <path> <text> [msg]` (a teammate push to origin).
- Each tool call is a new shell. Source `"$T/vf.env"` again in each one.

## Doctor

```bash
venfork doctor --json > "$T/doctor.json"; echo $?
```

Exit 0 and no check with `"ok": false` before you drive anything.
On the fixture, `token`, `last-run` and `cron-age` are `true` ("schedule disabled") or `skipped` ("origin is not a GitHub repository").
Run doctor again after the drive. Compare the two files.

## Drive

Open only the feature file for the command you changed: `references/features/<command>.md`.
The file names match `src/commands/<name>.ts`. `references/features/README.md` is the index.
For changes that cross commands, use `leak-invariants.md` and `multi-command-journeys.md`.

- Pipe output through `2>&1 | tail -3`. Spinners print control codes.
- Commands without a prompt: use `</dev/null`.
- A prompt with stdin at EOF exits 130 with `Cancelled: input ended at a prompt`.
- A piped `y` does not answer a clack confirm. Use `vf_yes`.

## Prove

Evidence is git state, read from the bare repos:

- Tips: `vf_tip "$VF_ORIGIN"`, `vf_tip "$VF_UPSTREAM"`, `vf_tip "$VF_PUBLIC" <branch>`.
- Push count: `vf_pushes "$VF_ORIGIN"` before and after. An idempotent run adds 0.
- Managed commit: `git -C "$VF_ORIGIN" log -1 --format='%an%n%B' main` shows `venfork-bot` and `Venfork-Managed: 1`.
- Files: `git -C "$VF_ORIGIN" show --stat --format= main`, `git -C "$VF_PUBLIC" ls-tree -r --name-only <branch>`.
- Leaks: `git -C "$VF_PUBLIC" log --format=%B main..<branch> | grep -i -e venfork -e "$VF_ORIGIN"` prints nothing.
- Config: `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json`.
- Health: `doctor --json` before and after.

## What usually lies

- Unit tests in `tests/unit` mock `execa` with strings. A `git rev-parse` there returns a stub. A green unit suite is not evidence for git plumbing, leases or SHAs.
- Integration tests (`bun run test:integration`) and a drive with this fixture are evidence.
- "Sync complete!" prints after a no-op too. Read the spinner lines (`already up to date` vs `Updated`) and the push count.
- `stage` rebuilds every commit, so the public SHA changes on every stage. Compare trees and subjects, not SHAs.
- The fixture remotes are local paths. The deny-list then holds the origin path and `venfork`, not `owner/name`.
- gh-backed paths (`setup`, `clone`, `pull`, `stage --pr`, issues) stop at the stub. Their success paths are proven only by e2e.

## Clean up

- Delete only what this run made: `rm -rf "$VF_ROOT" "$T"`. Do not delete other `venfork-fixture-*` dirs.
- For e2e (`bun run test:e2e`, real GitHub, opt-in), confirm afterwards that `gh repo list <owner> | grep venfork-e2e-` prints nothing.

---
command: clone
entry: src/commands/clone.ts
shared: [prompt]
config:
  read: [mode, upstreamUrl, publicForkUrl]
  written: []
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/clone-args.test.ts]
  integration: [tests/integration/cli.test.ts]
  e2e: []
---

## What exists

- Needs gh auth first (`AuthenticationError`).
- Refuses an empty or invalid repo ("Invalid vendor repository") and an existing `./<name>` directory ("Directory '<name>' already exists."). Both exit 1.
- `gh repo clone <owner/name> <name>`, then reads `venfork-config` from the mirror. When it exists it is authoritative: `--no-public` on a standard config, `--public-fork` on a no-public config, and an `--upstream` or `--public-fork` naming another repo are refused (exit 1). A flag naming the recorded repo in another URL form is accepted.
- Legacy mirror without a config: guesses the public fork by stripping `-private` (`gh repo view`), then the upstream from the fork's parent. Each failed guess prompts for a URL; an empty answer is rejected by `validate`, and the fork answer must be a GitHub URL or `owner/repo`. `--no-public` skips the fork; `--public-fork <url>` (URL or `owner/repo`) skips the fork guess and its prompt, and the parent lookup then runs on that fork; `--upstream` skips the parent lookup. `--public-fork` with `--no-public` is refused, and an invalid `--public-fork` exits 1 before cloning.
- Adds `public` (standard mode) and `upstream` with push URL `DISABLE`. URLs follow `gh config get git_protocol`. Runs `gh repo set-default`.
- A cancelled URL prompt exits 130 (`CommandExitError(130)`), and so does a prompt that hits stdin EOF.
- Never prompts without a TTY on stdin, with `CI` set, with `VENFORK_NONINTERACTIVE=1` or with `--no-input`: a URL prompt exits 2 (`MissingInputError`) naming `--public-fork <url>` for the public fork URL and `--upstream <url>` for the upstream URL. `--yes` is refused: clone has no confirm. Any failure or cancel after the clone removes the cloned directory, so the rerun with the named flag works.
- It never writes `venfork-config` and never pushes.

## How a user reaches it

`venfork clone <vendor-repo> [--no-public] [--upstream <url>] [--public-fork <url>] [--no-input]`. `<vendor-repo>` is the private mirror as a GitHub URL or `owner/repo`.

## How to drive it

The success path needs real GitHub; no e2e tier covers clone today. On the fixture, from `$VF_ROOT`:

```bash
cd "$VF_ROOT"
venfork clone </dev/null 2>&1; echo $?                                  # 1, "Vendor repository URL is required"
venfork clone bad </dev/null 2>&1 | grep -o "Invalid vendor repository"
mkdir b-private; venfork clone a/b-private </dev/null 2>&1 | grep -o "Directory.*"; rmdir b-private
venfork clone a/b-private </dev/null 2>&1 | grep "gh stub"               # exit 1 at gh repo clone
```

- Already current: a second clone into the same directory is refused, which is the idempotence guard.
- The fixture's gh stub fails `gh repo clone`, so the legacy paths need a gh that clones the fixture origin. `tests/integration/cli.test.ts` ("clone on a legacy mirror without venfork-config") deletes origin's `venfork-config` branch and uses such a stub: `clone acme/legacy-private --public-fork other-org/legacy` exits 0 with `public` = `git@github.com:other-org/legacy.git` and `upstream` = the fixture upstream (push `DISABLE`), and the same clone without `--public-fork` and without a TTY exits 2 with "Pass --public-fork <url>.".
- Cancel at a URL prompt needs a TTY; `tests/unit/commands.test.ts` pins the exit-130 paths and the `validate` rules.

## What proves it

- e2e or a manual run only: `git -C <name> remote -v` shows `origin`, `public` (standard), `upstream` with `(push) DISABLE`.
- `venfork doctor --json` inside the clone: `remotes` and `mode` ok.
- `git -C <name> config --get remote.public.url` matches `publicForkUrl` in `venfork-config`.

## What usually lies

- `tests/unit/commands.test.ts` mocks `gh repo clone` and `fetchVenforkConfig`. It cannot show that the config read from a real mirror matches the remotes.
- The fixture `work` clone was wired by the harness, not by `clone`.

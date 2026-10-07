---
command: clone
entry: src/commands/clone.ts
shared: []
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
- `gh repo clone <owner/name> <name>`, then reads `venfork-config` from the mirror. When it exists it is authoritative: `--no-public` on a standard config and a different `--upstream` are refused.
- Legacy mirror without a config: guesses the public fork by stripping `-private` (`gh repo view`), then the upstream from the fork's parent. Each failed guess prompts for a URL. `--no-public` skips the fork; `--upstream` skips the parent lookup.
- Adds `public` (standard mode) and `upstream` with push URL `DISABLE`. URLs follow `gh config get git_protocol`. Runs `gh repo set-default`.
- A cancelled URL prompt exits 1, not 130. A prompt that hits stdin EOF exits 130.
- It never writes `venfork-config` and never pushes.

## How a user reaches it

`venfork clone <vendor-repo> [--no-public] [--upstream <url>]`. `<vendor-repo>` is the private mirror as a GitHub URL or `owner/repo`.

## How to drive it

The success path needs real GitHub; no e2e tier covers clone today. On the fixture, from `$VF_ROOT`:

```bash
cd "$VF_ROOT"
venfork clone </dev/null 2>&1 | tail -1; echo $?                        # 1, "Clone failed"
venfork clone bad </dev/null 2>&1 | grep -o "Invalid vendor repository"
mkdir b-private; venfork clone a/b-private </dev/null 2>&1 | grep -o "Directory.*"; rmdir b-private
venfork clone a/b-private </dev/null 2>&1 | grep "gh stub"               # exit 1 at gh repo clone
```

- Already current: a second clone into the same directory is refused, which is the idempotence guard.
- Cancel at a URL prompt and the concurrent lease path are not reachable on the fixture: the first gh call fails first.

## What proves it

- e2e or a manual run only: `git -C <name> remote -v` shows `origin`, `public` (standard), `upstream` with `(push) DISABLE`.
- `venfork doctor --json` inside the clone: `remotes` and `mode` ok.
- `git -C <name> config --get remote.public.url` matches `publicForkUrl` in `venfork-config`.

## What usually lies

- `tests/unit/commands.test.ts` mocks `gh repo clone` and `fetchVenforkConfig`. It cannot show that the config read from a real mirror matches the remotes.
- The fixture `work` clone was wired by the harness, not by `clone`.

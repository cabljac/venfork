---
command: pull pr
entry: src/commands/pull-request.ts
shared: [args, mirror-commit, net]
config:
  read: [pulledPrs]
  written: [pulledPrs]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/pull-args.test.ts, tests/unit/dispatch.test.ts]
  integration: [tests/integration/cli.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- `venfork pull pr` needs gh auth once its arguments parse (`AuthenticationError`). A usage error is reported first.
- Resolves `upstream` (`RemoteNotFoundError`), parses it as a GitHub repo ("Could not parse upstream remote URL"), then the PR argument: a positive integer or a `github.com/<owner>/<repo>/pull/<n>` URL. A URL for another repo is refused.
- Reads the PR with `gh pr view`. Refuses an existing local `upstream-pr/<n>` unless `--branch-name` is given.
- `git fetch upstream pull/<n>/head:<branch>`, then a plain `git push origin <branch> --no-follow-tags` (no lease), then writes `pulledPrs[<branch>]` (number, URL, head, `lastSyncedAt`).
- `--no-push`, or a failed push, keeps the branch local and writes no `pulledPrs` entry. Both exit 0.
- Refresh is `venfork sync <branch>` (see `sync.md`): it finds the PR by `pulledPrs[branch]` or the name `upstream-pr/<n>`, force-fetches, pushes with a lease and needs no gh.
- The old `venfork pull-request` name exits 1 and names `venfork pull pr`.

## How a user reaches it

`venfork pull pr <n-or-url> [--branch-name <name>] [--no-push]`, then `venfork sync upstream-pr/<n>`. No prompt.

## How to drive it

`pull pr` itself stops on the fixture: the local upstream path is not a GitHub repo. Drive the edges and the refresh:

```bash
venfork pull pr 1 </dev/null 2>&1 | grep -o "Could not parse upstream remote URL"   # exit 1
venfork pull pr </dev/null 2>&1 | head -1                                          # usage, exit 1
venfork pull-request 1 </dev/null 2>&1                                             # rename hint, exit 1
git checkout -q -b pr-head upstream/main && echo p > src/p.txt && git add . && git commit -qm "feat: p"
git push -q "$VF_UPSTREAM" pr-head:refs/pull/7/head                                # fake upstream PR #7
venfork sync upstream-pr/7 </dev/null 2>&1 | tail -2                               # exit 0
N=$(vf_pushes "$VF_ORIGIN" upstream-pr/7); venfork sync upstream-pr/7 </dev/null >/dev/null 2>&1; echo "$N $(vf_pushes "$VF_ORIGIN" upstream-pr/7)"   # equal
echo q > src/q.txt && git add . && git commit -qm "feat: q" && git push -q -f "$VF_UPSTREAM" pr-head:refs/pull/7/head
venfork sync upstream-pr/7 </dev/null >/dev/null 2>&1; [ "$(vf_tip "$VF_ORIGIN" upstream-pr/7)" = "$(git rev-parse pr-head)" ] && echo refreshed
```

- Cancel: there is no prompt, so there is no 130 path.
- Concurrent lease: the refresh leases on the local `origin/upstream-pr/7` ref. Move the mirror branch from another clone (`git -C "$VF_ORIGIN_DEV" fetch -q origin upstream-pr/7 && git -C "$VF_ORIGIN_DEV" push -q -f origin FETCH_HEAD~1:refs/heads/upstream-pr/7`), move the PR head, refresh: it warns "moved since this sync fetched it", keeps the teammate's tip and still exits 0.

## What proves it

- `vf_tip "$VF_ORIGIN" upstream-pr/7` equals the PR head.
- `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` has `pulledPrs["upstream-pr/7"].head` at that SHA.
- `venfork doctor --json | jq .links.pulledPrs`.

## What usually lies

- `pullRequestCommand` tests in `tests/unit/commands.test.ts` mock gh and git as strings. Only e2e tier 4 proves the first import.
- A refresh that could not push still prints "synced with upstream PR". Check the tip.
- Each refresh writes a new `venfork-config` commit even when the PR did not move.

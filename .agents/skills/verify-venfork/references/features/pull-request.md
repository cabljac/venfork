---
command: pull pr
entry: src/commands/pull-request.ts
shared: [args, json-output, mirror-commit, net]
config:
  read: [pulledPrs]
  written: [pulledPrs]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/pull-args.test.ts, tests/unit/dispatch.test.ts, tests/unit/json-output.test.ts]
  integration: [tests/integration/cli.test.ts, tests/integration/net-credential.test.ts, tests/integration/pull-pr-refresh.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- `venfork pull pr` needs gh auth once its arguments parse (`AuthenticationError`). A usage error is reported first.
- Resolves `upstream` (`RemoteNotFoundError`), parses it as a GitHub repo ("Could not parse upstream remote URL"), then the PR argument: a positive integer or a `github.com/<owner>/<repo>/pull/<n>` URL. A URL for another repo is refused.
- Reads the PR with `gh pr view`. With `--branch-name`, upstream's default branch and `venfork-config` are refused (exit 1) before any fetch.
- `git fetch upstream pull/<n>/head` (no destination; the head is read from `FETCH_HEAD`). Without `--no-push`, `git ls-remote origin refs/heads/<branch>` and, when it exists, `git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>`. All through `netExec`, so gh is the only github.com credential helper.
- A local branch or origin branch of that name that is not venfork's copy of this PR (`pulledPrs[branch].upstreamPrNumber` is `<n>`, or no record and the name is `upstream-pr/<n>`) is refused (exit 1, nothing moved), with or without `--branch-name`, unless its tip is exactly the PR head (a re-run after a failed push).
- Nothing is lost: the run refuses (`PreconditionError`, exit 1, nothing moved) when the local branch or the fresh origin copy has commits reachable from neither the new PR head nor `pulledPrs[branch].head` (the PR commits a rebase drops). For the local branch, the `refs/remotes/origin/<branch>` tip from before this run's fetch also counts, so a clone left behind a teammate's refresh of a rebased PR is not refused. With no record there is no baseline, so a rebased PR is refused. The hint says to move the commits or use `--branch-name`.
- The local branch moves with `git update-ref <ref> <new> <old>`, or `git branch` when it does not exist (a second clone). A branch checked out here moves with `git reset --keep`; unstaged changes the new head would overwrite are refused and kept, and any staged change is refused (reset --keep would reset the index). A branch checked out in another worktree is refused.
- The push is always `pushBranchWithLease` with expected = the origin tip fetched in this run (empty means "must not exist"; no push when equal). Then `pulledPrs[<branch>]` (number, URL, head, `lastSyncedAt`) is written. `result.refreshed` is true when this PR's copy already existed locally, on origin or in the record.
- `--no-push`, or a failed push, keeps the branch local and writes no `pulledPrs` entry. `--no-push` exits 0; a failed push exits 1 with one `error:` line (no spinner `done:` line) that names the same re-run (with `--branch-name '<branch>'`, if one was used) and the outro `Pull incomplete: the branch is local only.`
- `--json`: `result` is `{ branch, head, prNumber, prUrl, pushed, refreshed }`; `pushed` is false with `--no-push` or a failed push; a failed push exits 1 (`partialFailureExitCode`). Failures are `ok: false` with `error.code` (`remote-not-found`, `usage`, `auth`, `internal` for an unparsable upstream URL, `not-in-repository` outside a git repository).
- Refresh is a re-run of `venfork pull pr <n>` (with the same `--branch-name`, if one was used). It needs gh, like the first pull. `venfork sync <branch>` is a usage error that names this command.
- The old `venfork pull-request` name exits 2 and names `venfork pull pr`. A malformed `<pr-number-or-url>` exits 2 at parse time; a URL to another repo than upstream exits 1.

## How a user reaches it

`venfork pull pr <n-or-url> [--branch-name <name>] [--no-push] [--no-input] [--json]`, then the same command again to refresh. No prompt: `--no-input` is accepted and changes nothing, and `--yes` is an unknown option (exit 2).

## How to drive it

On the plain fixture `pull pr` stops: the local upstream path is not a GitHub repo. To drive the whole flow, give upstream an owner/repo-shaped relative path and stub gh, as `tests/integration/pull-pr-refresh.test.ts` does:

```bash
cd "$VF_WORK" && mkdir -p acme && ln -s "$VF_UPSTREAM" acme/widget && echo acme/ >> .git/info/exclude
git remote set-url upstream acme/widget                      # parseRepoPath reads acme/widget; git reads a path
git -C "$VF_UPSTREAM_DEV" checkout -q -b feat && echo 1 > "$VF_UPSTREAM_DEV/pr.txt" \
  && git -C "$VF_UPSTREAM_DEV" add pr.txt && git -C "$VF_UPSTREAM_DEV" commit -qm pr \
  && git -C "$VF_UPSTREAM_DEV" push -q origin feat:refs/pull/7/head
# a gh first on PATH that answers `gh pr view` with {number,title,body,url,state,baseRefName,headRefName}
venfork pull pr 7; venfork pull pr 7                         # import, then refresh
```

Edges without that setup:

```bash
venfork pull pr 1 </dev/null 2>&1 | grep -o "Could not parse upstream remote URL"   # exit 1
venfork pull pr 1 --json </dev/null 2>/dev/null | jq -c .error                  # code internal, exit 1
venfork pull pr </dev/null 2>&1 | head -1                                          # usage, exit 2
venfork pull-request 1 </dev/null 2>&1                                             # rename hint, exit 2
venfork sync upstream-pr/7 </dev/null 2>&1; echo $?                              # names `venfork pull pr 7`, 2
```

- Cancel: there is no prompt, so there is no 130 path.
- Teammate commit: push a commit onto `upstream-pr/7` from `$VF_ORIGIN_DEV`, then `git fetch` in `$VF_WORK` and move the PR head. The refresh exits 1 with "1 commit(s) on origin/upstream-pr/7 are not in upstream PR #7" and origin keeps the teammate's tip.
- Unpushed local commit on `upstream-pr/7`: the refresh exits 1 naming `upstream-pr/7`, and the branch keeps the commit.
- Second clone with no local branch, PR rebased: the first run creates the branch and force-pushes the rebased head (`refreshed: true`).

## What proves it

- `vf_tip "$VF_ORIGIN" upstream-pr/7` equals the PR head.
- `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` has `pulledPrs["upstream-pr/7"].head` at that SHA.
- `venfork doctor --json | jq .links.pulledPrs`.

## What usually lies

- `pullRequestCommand` tests in `tests/unit/commands.test.ts` mock gh and git as strings. `tests/integration/pull-pr-refresh.test.ts` runs real git with a gh stub; only e2e tier 4 proves the real `pull/<n>/head` ref on GitHub.
- Each refresh writes a new `venfork-config` commit even when the PR did not move.

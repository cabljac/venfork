---
command: stage
entry: src/commands/stage.ts
shared: [approval, stage-gate, deny-list, redaction, prompt, divergence, json-output, managed-commit, mirror-commit, net, repo, worktree, constants]
config:
  read: [mode, upstreamUrl, publicForkUrl, preserve, invalidPreserve, approval]
  written: [shippedBranches]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/stage-args.test.ts, tests/unit/json-output.test.ts, tests/unit/redaction.test.ts, tests/unit/synthetic-body.test.ts, tests/unit/deny-list.test.ts, tests/unit/prompt.test.ts, tests/unit/approval.test.ts]
  integration: [tests/integration/cli.test.ts, tests/integration/stage.test.ts, tests/integration/stage-gate.test.ts, tests/integration/stage-gate-content.test.ts, tests/integration/stage-gate-review.test.ts, tests/integration/stage-gate-followups.test.ts, tests/integration/stage-publish-followups.test.ts, tests/integration/integrity.test.ts, tests/integration/deny-list.test.ts, tests/integration/net-credential.test.ts, tests/integration/approval-gate.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Refuses before any fetch: `venfork-config`, a branch name that hits the deny-list (`MirrorReferenceError`), a ref that is not a local branch (tag, remote ref), a missing branch (`BranchNotFoundError`), a missing `upstream` or `public` remote (`RemoteNotFoundError`), invalid preserve entries (`ConfigError`).
- After fetch: refuses upstream's default branch and a branch with no history in common with upstream.
- Reads the branch tip once, before the fetches; the merge-base check, the merge scan and the rebuild all use that commit, so a branch moved during the fetch does not change what ships (`tests/integration/stage.test.ts`, "stage reads the local branch once").
- Rebuilds the branch linearly on `upstream/<default>` by cherry-pick with hooks off. Managed commits are dropped. Merge commits are dropped; a merge with a manual conflict resolution is refused.
- Gates every rebuilt commit (see `leak-invariants.md`): `StageLeakError` for mirror-only paths or content, `MirrorReferenceError` for mirror terms in author, committer, message, file content or file name, and for bot-authored commits.
- Every publish refusal of the gate is `error.code` `stage-leak`, except text that names the mirror (`mirror-reference`, also bot commits, marker text and config-shaped JSON in a file) and a broken internal block in a PR body (`redaction`). `stage-leak` covers `StageLeakError` and these plain `VenforkError`s: a cherry-pick that fails on a preserved path upstream does not have, a reflog or a mirror-only history longer than the scan cap, a directory in mirror history where venfork writes a file, a blob over 100 MB.
- Shows commits and files, then asks "Push to public fork and open the upstream PR?" (no-public: "Push to upstream and open the PR?"; with `--no-pr`: "Push to public fork?" / "Push to upstream?"). `--yes` answers it. Unless stdin and stderr are both a TTY, and with `CI` set, with `VENFORK_NONINTERACTIVE=1` or with `--no-input`, the confirm without `--yes` exits 2 before it fetches with one line (here with `--no-pr`), `error: Not staged. "Push to public fork?" needs an answer and venfork cannot prompt here. Add --yes to confirm.` (`MissingInputError`), and nothing is pushed; stdout stays empty.
- Without `--no-pr`, an upstream or push remote that is not on github.com (GitHub Enterprise, a local path) is `precondition` "Cannot open an upstream PR: ... is not a GitHub repository." with the hint `Pass --no-pr to push the branch only.`, after the confirm check and before any fetch.
- Pushes `<head>:refs/heads/<branch>` with `--force-with-lease=<ref>:<tip from ls-remote>` and `--no-follow-tags`. No-public pushes to the upstream URL directly (the remote's push URL stays `DISABLE`).
- `--json` never prompts, even at a TTY (it implies `--no-input`). Outside a git repository, stage fails with `not-in-repository` (exit 1) before it reaches the confirm. Without `--yes` it is `ok: false`, `error: { code: 'missing-input', flag: '--yes' }`, exit 2. On success `result` is `{ branch, head, target: 'public' | 'upstream', compareUrl, prAction?, prUrl?, internalPrUrl? }`; `prAction` (`created`, `updated`, `unchanged`, `failed`) is present unless `--no-pr`; `failed` (the PR could not be opened, or an existing PR's body could not be updated) exits 1 with the success envelope, an `error:` line and the outro `Stage incomplete: ...`. The outro names the re-run in the explicit form with the same PR flags, each value shell-quoted (`stageRerunCommand`: `venfork stage branch '<name>' [--no-pr] [--draft] [--base '<b>'] [--title '<t>'] [--internal-pr <n>] [--no-update-existing]`).
- `--dry-run` runs the plan, the rebuild, the gate and (with the PR) the internal PR lookup and redaction, prints the preview notes and the outro `Dry run: nothing was pushed. ...`, and exits 0. It skips the confirm, so it needs no `--yes`. `result` is `{ dryRun: true, branch, head, target, compareUrl, base, commits, files, removedLater, prTitle?, prBody?, existingPrUrl?, internalPrUrl? }`. With the PR it also runs a read-only `gh pr list` for an open upstream PR on the same head and base; when one is open it sets `existingPrUrl`, drops `prTitle` (a re-stage keeps the title) and, with `--no-update-existing`, drops `prBody`. No push, no `gh pr create|edit`, no `shippedBranches` write. `head` is the preview rebuild's local commit; a real stage rebuilds with a new SHA and the same tree. Gate refusals (`stage-leak`, `mirror-reference`, "Nothing to stage") still fail the dry run. `--dry-run` on `stage issue` is a usage error.
- The PR step is the default (`--no-pr` skips it; `--pr` is an accepted no-op alias for one release). `--draft`, `--title`, `--internal-pr`, `--no-update-existing` and `--pr` with `--no-pr` are usage errors (exit 2); `--base` is allowed (compare link). A branch with no commits to publish beyond `upstream/<default>` (merge commits and venfork-managed commits are dropped, so a branch carrying only those counts) is `precondition` "Nothing to stage" before the confirm, with the hint `Commit your work on the branch first.`.
- The PR step: finds the internal PR on the mirror, redacts it (`stripInternalBlocks`, `RedactionError`), runs `gh pr create`, updates an existing PR body unless `--no-update-existing`, writes `shippedBranches[branch]`. The entry's `sourceHead` is the mirror commit that was staged; its `head` is the rebuilt commit that was pushed. When `gh pr create` fails, the Next Steps note says the upstream PR was not opened and gives the compare URL, and the outro `Stage incomplete: finish the PR with \`venfork stage <branch> ...\` again or by hand.` repeats the PR flags the run used (`--draft`, `--base`, `--title`, `--internal-pr`, `--no-update-existing`); only a `--no-pr` run gets the tip to re-run without `--no-pr`.
- With `approval` set (`reviewed`, `two-person`), stage reads the branch's open mirror PR, its reviews, the candidate approvers' permissions, its check runs and statuses through `gh api` (netExec), after the fetch and before the rebuild. Refusals are `ApprovalError` code `approval` (exit 1) with `details.reason` `no-mirror-pr`, `wrong-head`, `wrong-base`, `ambiguous-pr`, `branch-moved`, `changes-requested`, `not-approved`, `self-approved`, `checks-pending` or `checks-failed`; a non-GitHub origin is `precondition`. The PR must come from the branch on the mirror and target the mirror default branch (`base.repo.default_branch`); among several open PRs for the branch only those into the default branch count, and more than one is `ambiguous-pr` (name one with `--internal-pr`). Each reviewer's latest APPROVED, CHANGES_REQUESTED or DISMISSED review counts; a dismissed one is no opinion. Only `user.type === 'User'` approvals count; reviews with no login are skipped. The gh login (`gh api user`) is read only at `two-person`. The `--paginate --jq` reads end in `| tojson`, so a TTY or `GH_FORCE_TTY` does not indent them (the gh stub indents otherwise). A pass pins the rebuild to the approved head (`source.sha`) and the upstream PR body to the approved PR number; `result.approval` is `{ level, ok: true, prUrl, headSha, approvers }`. `--dry-run` reports a refusal as `result.approval.ok: false` and a warning, and still previews. Nothing about the approval reaches the public fork or upstream (`tests/integration/approval-gate.test.ts` pins the published messages). With the level `off` stage makes no gh call for it. `stage issue` is not gated: it publishes redacted issue text, not code.
- In-process callers can pass `source: { sha }` (stage that full commit id under the branch name, with no local branch read). A short id, an invalid branch name or a commit missing from the clone is a `precondition` refusal before any fetch. The CLI never sets it.

## How a user reaches it

`venfork stage <branch>`, `venfork stage branch <name>` (for a branch named `issue`, `approval` or `branch`), plus `--no-pr`, `--draft`, `--dry-run`, `--title <t>`, `--base <b>`, `--internal-pr <n>`, `--no-update-existing`, `--yes`/`-y`, `--no-input`, `--json`. `stage issue` is in `issue.md`; `stage approval` is in `approval.md`.

## How to drive it

```bash
git checkout -q -b feat upstream/main && echo f > src/feat.txt && git add . && git commit -qm "feat: add feat"
venfork stage feat --no-pr </dev/null 2>&1; echo $?                    # 2, "Add --yes to confirm."; nothing on $VF_PUBLIC
VENFORK_NONINTERACTIVE=1 venfork stage feat --no-pr </dev/null 2>&1; echo $?   # 2 as well: it does not confirm
venfork stage feat --no-pr --json </dev/null 2>/dev/null; echo $?      # missing-input envelope naming --yes, 2
venfork stage feat --no-pr --dry-run --json </dev/null 2>/dev/null | jq -c '.result | [.dryRun, .commits]'   # [true,[...]]; vf_tip "$VF_PUBLIC" feat is still empty
venfork stage feat --no-pr --yes </dev/null >/dev/null 2>&1; echo $?    # 0
venfork stage feat --no-pr --yes --json </dev/null 2>/dev/null | jq -r .result.head   # equals vf_tip "$VF_PUBLIC" feat
vf_yes stage feat --no-pr >/dev/null 2>&1; echo $?                      # 0 (answers the confirm through a pseudo-TTY)
A=$(vf_tip "$VF_PUBLIC" feat); vf_yes stage feat --no-pr >/dev/null 2>&1; vf_tip "$VF_PUBLIC" feat   # differs from $A
git checkout -q -b leak upstream/main && mkdir -p .github/workflows && echo x > .github/workflows/venfork-sync.yml && git add . && git commit -qm "ci: wf"
venfork stage leak --no-pr </dev/null 2>&1 | grep -o "Refusing to stage.*"   # StageLeakError, exit 1
venfork stage leak --no-pr --yes --json </dev/null 2>/dev/null | jq -r .error.code   # stage-leak
git checkout -q -b word upstream/main && echo w > src/w.txt && git add . && git commit -qm "chore: via venfork"
venfork stage word --no-pr </dev/null 2>&1 | grep -o "Refusing to publish.*" # MirrorReferenceError
venfork stage word --no-pr --yes --json </dev/null 2>/dev/null | jq -r .error.code   # mirror-reference
venfork stage main --no-pr --yes </dev/null; venfork stage venfork-config --no-pr </dev/null; venfork stage nope --no-pr </dev/null   # all exit 1
venfork stage feat --yes </dev/null 2>&1 | grep -o "Cannot open an upstream PR.*"   # the default PR step: local upstream is not GitHub
```

- No-public: launch with `--own-upstream`; `vf_yes stage feat --no-pr` puts `feat` on `$VF_UPSTREAM`.
- Hidden prompt: `script -q /dev/null sh -c 'node "$VF_CLI" stage feat --no-pr 2>/dev/null; echo EXIT=$?' </dev/null` prints `EXIT=2` (macOS `script`; on Linux `script -qec '...' /dev/null`). `$VF_PUBLIC` has no `feat`.
- Concurrent lease: the lease is read by `ls-remote` right before the push. No CLI drive or test pins the "moved while staging" error.

## What proves it

- `git -C "$VF_PUBLIC" rev-parse feat^{tree}` equals `git rev-parse feat^{tree}`. `git -C "$VF_PUBLIC" log --format=%s main..feat` lists only your subjects.
- `git -C "$VF_PUBLIC" ls-tree -r --name-only feat` has no `.github/workflows/venfork-sync.yml`, no `.venfork/`, no preserved path.
- After a refusal: `git -C "$VF_PUBLIC" rev-parse -q --verify refs/heads/<branch>` fails.
- `git -C "$VF_PUBLIC" log --format='%an%n%cn%n%B' main..feat | grep -ci -e venfork -e "$VF_ORIGIN"` prints 0.

## What usually lies

- Every stage rebuilds, so each run pushes a new SHA (`vf_pushes "$VF_PUBLIC" feat` grows by 1). Compare trees, not SHAs.
- A piped `printf y` does not confirm. Without a TTY the command exits 2 before reading stdin.
- A TTY on stdin is not enough. At a terminal, `venfork stage feat --no-pr 2>/dev/null` (or `2>log`) exits 2 naming `--yes` and pushes nothing: stderr is not a TTY, so the prompt would be hidden. `tests/integration/cli.test.ts` ("stage with stderr redirected at a TTY") pins it.
- The fixture deny-list has the origin path and `venfork` only. `owner/name` and repo-name terms need a GitHub URL: see `tests/integration/stage-gate-content.test.ts`.
- The PR step cannot succeed on the fixture, so every fixture drive passes `--no-pr` (`tests/unit/docs-drift.test.ts` refuses a verify-venfork stage drive without it); without it stage stops at "Cannot open an upstream PR" before the leak gate runs. The redaction and PR payload are proven by `tests/unit/redaction.test.ts` and e2e tier 3 only.

---
command: stage
entry: src/commands/stage.ts
shared: [stage-gate, deny-list, redaction, confirm, divergence, managed-commit, mirror-commit, net, repo, worktree, constants]
config:
  read: [mode, upstreamUrl, publicForkUrl, preserve, invalidPreserve]
  written: [shippedBranches]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/stage-args.test.ts, tests/unit/redaction.test.ts, tests/unit/synthetic-body.test.ts, tests/unit/deny-list.test.ts]
  integration: [tests/integration/stage.test.ts, tests/integration/stage-gate.test.ts, tests/integration/stage-gate-content.test.ts, tests/integration/stage-gate-review.test.ts, tests/integration/stage-gate-followups.test.ts, tests/integration/stage-publish-followups.test.ts, tests/integration/integrity.test.ts, tests/integration/deny-list.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Refuses before any fetch: `venfork-config`, a branch name that hits the deny-list (`MirrorReferenceError`), a ref that is not a local branch (tag, remote ref), a missing branch (`BranchNotFoundError`), a missing `upstream` or `public` remote (`RemoteNotFoundError`), invalid preserve entries (`ConfigError`).
- After fetch: refuses upstream's default branch and a branch with no history in common with upstream.
- Rebuilds the branch linearly on `upstream/<default>` by cherry-pick with hooks off. Managed commits are dropped. Merge commits are dropped; a merge with a manual conflict resolution is refused.
- Gates every rebuilt commit (see `leak-invariants.md`): `StageLeakError` for mirror-only paths or content, `MirrorReferenceError` for mirror terms in author, committer, message, file content or file name, refusal of bot-authored commits.
- Shows commits and files, then asks "Push to public fork?" (no-public: "Push to upstream?"). `VENFORK_NONINTERACTIVE=1` answers yes only with `--pr`.
- Pushes `<head>:refs/heads/<branch>` with `--force-with-lease=<ref>:<tip from ls-remote>` and `--no-follow-tags`. No-public pushes to the upstream URL directly (the remote's push URL stays `DISABLE`).
- `--pr`/`--draft`: finds the internal PR on the mirror, redacts it (`stripInternalBlocks`, `RedactionError`), runs `gh pr create`, updates an existing PR body unless `--no-update-existing`, writes `shippedBranches[branch]`.

## How a user reaches it

`venfork stage <branch>`, `venfork stage branch <name>` (for a branch named `issue` or `branch`), plus `--pr`, `--draft`, `--title <t>`, `--base <b>`, `--internal-pr <n>`, `--no-update-existing`. `stage issue` is in `issue.md`.

## How to drive it

```bash
git checkout -q -b feat upstream/main && echo f > src/feat.txt && git add . && git commit -qm "feat: add feat"
venfork stage feat </dev/null 2>&1; echo $?                    # 130, "Cancelled: input ended at a prompt"
vf_yes stage feat >/dev/null 2>&1; echo $?                      # 0
A=$(vf_tip "$VF_PUBLIC" feat); vf_yes stage feat >/dev/null 2>&1; vf_tip "$VF_PUBLIC" feat   # differs from $A
git checkout -q -b leak upstream/main && mkdir -p .github/workflows && echo x > .github/workflows/venfork-sync.yml && git add . && git commit -qm "ci: wf"
venfork stage leak </dev/null 2>&1 | grep -o "Refusing to stage.*"   # StageLeakError, exit 1
git checkout -q -b word upstream/main && echo w > src/w.txt && git add . && git commit -qm "chore: via venfork"
venfork stage word </dev/null 2>&1 | grep -o "Refusing to publish.*" # MirrorReferenceError
venfork stage main </dev/null; venfork stage venfork-config </dev/null; venfork stage nope </dev/null   # all exit 1
venfork stage feat --pr </dev/null 2>&1 | grep -o "Cannot open an upstream PR.*"   # local upstream is not GitHub
```

- No-public: launch with `--no-public`; `vf_yes stage feat` puts `feat` on `$VF_UPSTREAM`.
- Concurrent lease: the lease is read by `ls-remote` right before the push. No CLI drive or test pins the "moved while staging" error.

## What proves it

- `git -C "$VF_PUBLIC" rev-parse feat^{tree}` equals `git rev-parse feat^{tree}`. `git -C "$VF_PUBLIC" log --format=%s main..feat` lists only your subjects.
- `git -C "$VF_PUBLIC" ls-tree -r --name-only feat` has no `.github/workflows/venfork-sync.yml`, no `.venfork/`, no preserved path.
- After a refusal: `git -C "$VF_PUBLIC" rev-parse -q --verify refs/heads/<branch>` fails.
- `git -C "$VF_PUBLIC" log --format='%an%n%cn%n%B' main..feat | grep -ci -e venfork -e "$VF_ORIGIN"` prints 0.

## What usually lies

- Every stage rebuilds, so each run pushes a new SHA (`vf_pushes "$VF_PUBLIC" feat` grows by 1). Compare trees, not SHAs.
- A piped `printf y` does not confirm. The command still exits 130.
- The fixture deny-list has the origin path and `venfork` only. `owner/name` and repo-name terms need a GitHub URL: see `tests/integration/stage-gate-content.test.ts`.
- `--pr` cannot succeed on the fixture. The redaction and PR payload are proven by `tests/unit/redaction.test.ts` and e2e tier 3 only.

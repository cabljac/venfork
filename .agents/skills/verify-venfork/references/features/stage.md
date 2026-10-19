---
command: stage
entry: src/commands/stage.ts
shared: [stage-gate, deny-list, redaction, prompt, divergence, json-output, managed-commit, mirror-commit, net, repo, worktree, constants]
config:
  read: [mode, upstreamUrl, publicForkUrl, preserve, invalidPreserve]
  written: [shippedBranches]
tests:
  unit: [tests/unit/commands.test.ts, tests/unit/stage-args.test.ts, tests/unit/json-output.test.ts, tests/unit/redaction.test.ts, tests/unit/synthetic-body.test.ts, tests/unit/deny-list.test.ts, tests/unit/prompt.test.ts]
  integration: [tests/integration/cli.test.ts, tests/integration/stage.test.ts, tests/integration/stage-gate.test.ts, tests/integration/stage-gate-content.test.ts, tests/integration/stage-gate-review.test.ts, tests/integration/stage-gate-followups.test.ts, tests/integration/stage-publish-followups.test.ts, tests/integration/integrity.test.ts, tests/integration/deny-list.test.ts, tests/integration/net-credential.test.ts]
  e2e: [tests/e2e/sync-flow.test.ts]
---

## What exists

- Refuses before any fetch: `venfork-config`, a branch name that hits the deny-list (`MirrorReferenceError`), a ref that is not a local branch (tag, remote ref), a missing branch (`BranchNotFoundError`), a missing `upstream` or `public` remote (`RemoteNotFoundError`), invalid preserve entries (`ConfigError`).
- After fetch: refuses upstream's default branch and a branch with no history in common with upstream.
- Rebuilds the branch linearly on `upstream/<default>` by cherry-pick with hooks off. Managed commits are dropped. Merge commits are dropped; a merge with a manual conflict resolution is refused.
- Gates every rebuilt commit (see `leak-invariants.md`): `StageLeakError` for mirror-only paths or content, `MirrorReferenceError` for mirror terms in author, committer, message, file content or file name, and for bot-authored commits.
- Every publish refusal of the gate is `error.code` `stage-leak`, except text that names the mirror (`mirror-reference`, also bot commits, marker text and config-shaped JSON in a file) and a broken internal block in a PR body (`redaction`). `stage-leak` covers `StageLeakError` and these plain `VenforkError`s: a cherry-pick that fails on a preserved path upstream does not have, a reflog or a mirror-only history longer than the scan cap, a directory in mirror history where venfork writes a file, a blob over 100 MB.
- Shows commits and files, then asks "Push to public fork?" (no-public: "Push to upstream?"). `--yes` answers it. Unless stdin and stderr are both a TTY, and with `CI` set, with `VENFORK_NONINTERACTIVE=1` or with `--no-input`, the confirm without `--yes` exits 2 before it fetches with one line, `error: Not staged. "Push to public fork?" needs an answer and venfork cannot prompt here. Add --yes to confirm.` (`MissingInputError`), and nothing is pushed; stdout stays empty.
- Pushes `<head>:refs/heads/<branch>` with `--force-with-lease=<ref>:<tip from ls-remote>` and `--no-follow-tags`. No-public pushes to the upstream URL directly (the remote's push URL stays `DISABLE`).
- `--json` never prompts, even at a TTY (it implies `--no-input`). Outside a git repository, stage fails with `not-in-repository` (exit 1) before it reaches the confirm. Without `--yes` it is `ok: false`, `error: { code: 'missing-input', flag: '--yes' }`, exit 2. On success `result` is `{ branch, head, target: 'public' | 'upstream', compareUrl, prAction?, prUrl?, internalPrUrl? }`; `prAction` (`created`, `updated`, `unchanged`, `failed`) is present only with `--pr`.
- `--pr`/`--draft`: finds the internal PR on the mirror, redacts it (`stripInternalBlocks`, `RedactionError`), runs `gh pr create`, updates an existing PR body unless `--no-update-existing`, writes `shippedBranches[branch]`.

## How a user reaches it

`venfork stage <branch>`, `venfork stage branch <name>` (for a branch named `issue` or `branch`), plus `--pr`, `--draft`, `--title <t>`, `--base <b>`, `--internal-pr <n>`, `--no-update-existing`, `--yes`/`-y`, `--no-input`, `--json`. `stage issue` is in `issue.md`.

## How to drive it

```bash
git checkout -q -b feat upstream/main && echo f > src/feat.txt && git add . && git commit -qm "feat: add feat"
venfork stage feat </dev/null 2>&1; echo $?                    # 2, "Add --yes to confirm."; nothing on $VF_PUBLIC
VENFORK_NONINTERACTIVE=1 venfork stage feat </dev/null 2>&1; echo $?   # 2 as well: it does not confirm
venfork stage feat --json </dev/null 2>/dev/null; echo $?      # missing-input envelope naming --yes, 2
venfork stage feat --yes </dev/null >/dev/null 2>&1; echo $?    # 0
venfork stage feat --yes --json </dev/null 2>/dev/null | jq -r .result.head   # equals vf_tip "$VF_PUBLIC" feat
vf_yes stage feat >/dev/null 2>&1; echo $?                      # 0 (answers the confirm through a pseudo-TTY)
A=$(vf_tip "$VF_PUBLIC" feat); vf_yes stage feat >/dev/null 2>&1; vf_tip "$VF_PUBLIC" feat   # differs from $A
git checkout -q -b leak upstream/main && mkdir -p .github/workflows && echo x > .github/workflows/venfork-sync.yml && git add . && git commit -qm "ci: wf"
venfork stage leak </dev/null 2>&1 | grep -o "Refusing to stage.*"   # StageLeakError, exit 1
venfork stage leak --yes --json </dev/null 2>/dev/null | jq -r .error.code   # stage-leak
git checkout -q -b word upstream/main && echo w > src/w.txt && git add . && git commit -qm "chore: via venfork"
venfork stage word </dev/null 2>&1 | grep -o "Refusing to publish.*" # MirrorReferenceError
venfork stage word --yes --json </dev/null 2>/dev/null | jq -r .error.code   # mirror-reference
venfork stage main </dev/null; venfork stage venfork-config </dev/null; venfork stage nope </dev/null   # all exit 1
venfork stage feat --pr </dev/null 2>&1 | grep -o "Cannot open an upstream PR.*"   # local upstream is not GitHub
```

- No-public: launch with `--no-public`; `vf_yes stage feat` puts `feat` on `$VF_UPSTREAM`.
- Hidden prompt: `script -q /dev/null sh -c 'node "$VF_CLI" stage feat 2>/dev/null; echo EXIT=$?' </dev/null` prints `EXIT=2` (macOS `script`; on Linux `script -qec '...' /dev/null`). `$VF_PUBLIC` has no `feat`.
- Concurrent lease: the lease is read by `ls-remote` right before the push. No CLI drive or test pins the "moved while staging" error.

## What proves it

- `git -C "$VF_PUBLIC" rev-parse feat^{tree}` equals `git rev-parse feat^{tree}`. `git -C "$VF_PUBLIC" log --format=%s main..feat` lists only your subjects.
- `git -C "$VF_PUBLIC" ls-tree -r --name-only feat` has no `.github/workflows/venfork-sync.yml`, no `.venfork/`, no preserved path.
- After a refusal: `git -C "$VF_PUBLIC" rev-parse -q --verify refs/heads/<branch>` fails.
- `git -C "$VF_PUBLIC" log --format='%an%n%cn%n%B' main..feat | grep -ci -e venfork -e "$VF_ORIGIN"` prints 0.

## What usually lies

- Every stage rebuilds, so each run pushes a new SHA (`vf_pushes "$VF_PUBLIC" feat` grows by 1). Compare trees, not SHAs.
- A piped `printf y` does not confirm. Without a TTY the command exits 2 before reading stdin.
- A TTY on stdin is not enough. At a terminal, `venfork stage feat 2>/dev/null` (or `2>log`) exits 2 naming `--yes` and pushes nothing: stderr is not a TTY, so the prompt would be hidden. `tests/integration/cli.test.ts` ("stage with stderr redirected at a TTY") pins it.
- The fixture deny-list has the origin path and `venfork` only. `owner/name` and repo-name terms need a GitHub URL: see `tests/integration/stage-gate-content.test.ts`.
- `--pr` cannot succeed on the fixture. The redaction and PR payload are proven by `tests/unit/redaction.test.ts` and e2e tier 3 only.

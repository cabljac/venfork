---
name: review-venfork
description: Adversarial review of a venfork branch or stack, one reviewer per risk seam, each in an isolated worktree, with real-git experiments. Use when asked to review, audit or stress-test venfork changes.
---

# Review venfork by risk seam

Split the diff by seam. Start one reviewer per touched seam, each in its own git worktree. Each reviewer tries to break the invariant with real git, using `tests/harness/mirror-fixture.ts` (`createMirrorFixture`) for local bare upstream/origin/public repos. Mocked execa proves little here.

## Seams

1. Leak to public/upstream. Files: `src/shared/stage-gate.ts`, `src/shared/deny-list.ts`, `src/shared/redaction.ts`, `src/commands/stage.ts`, `src/shared/preserve-entries.ts`. Invariant: nothing mirror-only reaches public or upstream. Try: stage a branch with a commit that adds a preserved path; put `venfork` or the mirror owner in an author, committer, message or PR title; use mixed-case or unmatched `venfork:internal` markers in a body.
2. Data loss on sync. Files: `src/commands/sync.ts`, `src/shared/divergence.ts`, `src/shared/mirror-commit.ts`, `src/shared/managed-commit.ts`. Invariant: sync never drops a non-managed commit, and the managed commit SHA depends only on the upstream tip and tree. Try: add a user commit under a legacy managed subject; move origin between lease read and push; run sync twice and compare SHAs.
3. Config-branch concurrency. Files: `src/config.ts` (`updateVenforkConfig`, lease on `venfork-config`), `src/shared/config-change.ts`, `tests/integration/preserve-concurrency.test.ts`. Invariant: concurrent config writes never lose a patch. Try: copy the test-local `mock.module` wrappers in that test (`beforeConfigWrite`, `beforeConfigChange` around `updateVenforkConfig` and `applyConfigChange`; the product has no such hook) to land a second write mid-update; patch with `null` against a stale read; exhaust the retry loop.
4. Token and secret scope. Files: `src/workflow.ts`, `src/shared/push-token.ts`, `src/commands/doctor.ts` (`token` check), `src/commands/schedule.ts`. Invariant: the generated workflow holds the least privilege and never prints a token. Try: read the YAML for `permissions`, `secrets.*` in logs and fork-triggered events; run doctor with no token and with a read-only token; check that advice text does not suggest a wider scope than needed.
5. Version pin and migration. Files: `src/shared/semver.ts`, `src/shared/mirror-commit.ts`, `src/errors.ts` (`PinDowngradeError`, `UnmigratedMirrorError`), `isUnpinnedWorkflow`. Invariant: a mirror is never silently downgraded or left on an unpinned workflow. Try: run an older CLI against a newer pin; sync a mirror with a pre-pin workflow; set `VENFORK_INSTALL_SPEC` to an odd value.
6. Network safety. Files: `src/shared/net.ts` (`netExec`, `runNetOp`, `netFetch`), `src/shared/constants.ts`. Invariant: every network git/gh call has no stdin, a timeout and `BatchMode=yes`. Try: `grep` for raw `$` or `execa` calls on `clone`, `fetch`, `push`, `gh api`; set `VENFORK_GIT_TIMEOUT=1`; point a remote at a host that asks for credentials.
7. CLI contract. Files: `src/index.ts`, `src/dispatch.ts`, `src/*-args.ts`, `src/commands/help.ts`, `tests/unit/docs-drift.test.ts`. Invariant: parsers reject bad input before any side effect, help and README match the flags, and cancel exits 130. Try: unknown flags, missing values, `--` and repeated flags; compare `--help` with README; cancel a prompt and check the exit code.

## Report format

Rank findings by severity (critical, high, medium, low). Each finding has: seam, file:line, repro (exact commands against the fixture), and the red test to add (file and test name).

## Triage

- Fix now: the invariant breaks, or data or secrets can leak.
- Follow-up issue: real but outside the diff, or needs a design call. Open the issue and link it.
- Dismissed: give the reason, for example "unreachable because X at file:line".

Every confirmed finding lands with a test that is red on the previous commit. Show the red run before the fix.

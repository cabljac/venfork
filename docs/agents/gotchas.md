# Gotchas

Append after a correction. When a gotcha is written here twice or hit twice, turn it into a check (scripts/lint-invariants.ts, a test, or a script) and delete it here.

## fs mocks spread the real module
A unit `node:fs/promises` mock must spread the real module (`...realFsPromises`). `mock.module` leaks across files (CLAUDE.md, "Commands"), so a partial mock breaks other files' tests.

## expected-counts.json is exact
`tests/expected-counts.json` is compared exactly and skipped tests are subtracted. Bump it by the number of tests you added and say why in the PR.

## Unit tests string-mock execa
Remote tip lookups (`git rev-parse --verify refs/remotes/<r>/...`) are answered by the dispatcher in `tests/unit/commands.test.ts` as `<remote>0tip`, for example `upstream0tip`.

## Snapshots
Run `bun test -u` only after reading the diff. The workflow YAML snapshot (`tests/unit/__snapshots__/workflow.test.ts.snap`, token mode) must never change. "Token mode" means the `scheduleAuth` token mode once the #85 stack lands.

## pinnedVenforkVersion takes the first match
`pinnedVenforkVersion` matches the first `venfork@` occurrence in the workflow YAML, so never add that string elsewhere in the YAML.

## GitHub listings are eventually consistent
Issue search and REST listings lag by seconds. e2e polls with `waitForOpenIssuesWithLabel`.

## npm publish is async
Observed on 2026-10-06, for one release: after a green release job, metadata appeared in about 8 min and the tarball in about 11 min.

## Biome reformats on check
After `bun run check`, re-read a file before editing by string match.

## Subagents must not run gh stack
Stack metadata is shared in `.git` across worktrees. Only the main checkout drives a stack.

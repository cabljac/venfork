# Gotchas

Append after a correction. When a gotcha is written here twice or hit twice, turn it into a check (scripts/lint-invariants.ts, a test, or a script) and delete it here.

## mock.module leaks across files
It leaks across files in one bun process, so unit and integration run in separate processes. A `node:fs/promises` mock must spread the real module (`...realFsPromises`) or it breaks other files' tests.

## Bare bun test runs only unit
`bunfig.toml` roots tests at `tests/unit`. Integration needs `bun test ./tests/integration`. `bun run test` runs both with the exact count gate.

## check autofixes, verify gates
`bun run check` rewrites files. `bun run verify` (PR #88) is the gate.

## expected-counts.json is exact
`tests/expected-counts.json` is compared exactly and skipped tests are subtracted. Bump it by the number of tests you added and say why in the PR.

## Unit tests string-mock execa
Remote tip lookups (`git rev-parse --verify refs/remotes/<r>/...`) are answered by the dispatcher in `tests/unit/commands.test.ts` as `<remote>0tip`, for example `upstream0tip`.

## Snapshots
Run `bun test -u` only after reading the diff. The workflow YAML snapshot (`tests/unit/__snapshots__/workflow.test.ts.snap`, token mode) must never change.

## Workflow YAML drives the managed commit
The managed commit SHA is a function of the upstream tip and the tree. Any YAML change changes the SHA and causes a push on the next sync. `pinnedVenforkVersion` matches the first `venfork@` occurrence, so never add that string elsewhere in the YAML.

## GitHub listings are eventually consistent
Issue search and REST listings lag by seconds. e2e polls with `waitForOpenIssuesWithLabel`.

## npm publish is async
After a green release job, metadata appears in about 8 min and the tarball in about 11 min.

## Biome reformats on check
After `bun run check`, re-read a file before editing by string match.

## gh network calls time out
`gh` calls from this machine intermittently time out. Retry.

## Subagents must not run gh stack
Stack metadata is shared in `.git` across worktrees. Only the main checkout drives a stack.

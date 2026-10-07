<!-- Write the body as ~150 words of prose: problem, fix, tests. No checklists. -->

What changed and why. End with "Fixes #N" or "Part of #N". Name any deliberate deviation from the issue.

Red-first tests. Name the tests that failed on the previous commit and now pass.

Verification run. `bun run verify` once it exists, else `bun run check && bun run test`. Say which harness feature file you drove, from `.agents/skills/verify-venfork/references/features/<cmd>.md`.

Not verified. Name what you did not run: e2e tiers, live GitHub, the Node build.

Count gate. If `tests/expected-counts.json` changed, say why and give the delta per suite.

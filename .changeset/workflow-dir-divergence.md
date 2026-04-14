---
'venfork': patch
---

`venfork sync` and `venfork stage`: identify internal workflow commits by content instead of position.

- `sync` now treats any divergent commit whose changed files all live under `.github/workflows/` as a managed workflow commit. Previously only commits that exclusively touched the single managed `venfork-sync.yml` file were filtered, so historical rollout commits that bundled multiple workflow files (e.g. `sync.yml` + `venfork-sync.yml`) still tripped the divergence guard and aborted sync.
- `stage` no longer relies on `git rebase --onto upstream/<default> origin/<default>` to drop the managed workflow commit. After a `venfork sync` rewrites `origin`'s default branch, older feature branches could still reach the *previous* managed workflow commit; the rebase would replay it onto upstream and leak it into the public fork. Stage now cherry-picks `upstream/<default>..<branch>` onto a detached worktree at `upstream/<default>`, skipping any commit classified as a workflow commit — so filtering is content-based and robust to prior sync rewrites.
- `stage` also passes `--no-merges` when enumerating branch commits. Merge commits (typically used to pull `origin/<default>` back into a feature branch after a sync rewrite) can't be cherry-picked without `-m` and their content is already covered by the linearized first-parent commits, so they're now skipped.

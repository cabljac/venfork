---
'venfork': patch
---

`venfork sync`: treat any divergent commit whose changed files all live under `.github/workflows/` as a managed workflow commit. Previously only commits that exclusively touched the single managed `venfork-sync.yml` file were filtered, so historical rollout commits that added multiple workflow files in one go (e.g. `sync.yml` + `venfork-sync.yml`) still tripped the divergence guard and aborted sync.

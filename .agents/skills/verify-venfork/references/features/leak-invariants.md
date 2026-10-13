# Leak invariants

Nothing from the private mirror reaches the public fork or upstream unless the user stages it.
Each row names what must never leak, the gate, and the drive that proves the gate holds.
Run the drives from `$VF_WORK` after Launch. Each refusal exits 1 and leaves no ref on `$VF_PUBLIC`.

| Must never leak | Gate | Where |
|---|---|---|
| The managed commit and `.github/workflows/venfork-sync.yml` | sync pushes public to the upstream tip only; stage drops managed commits and refuses the path (`StageLeakError`) | `src/commands/sync.ts`, `src/shared/stage-gate.ts` |
| `.venfork/` and the config branch | stage refuses `venfork-config` by name, `.venfork/` paths (any case) and config-shaped JSON | `src/commands/stage.ts`, `src/shared/stage-gate.ts` |
| Preserved files, by path or by content | `StageLeakError` for an added or changed preserved path, an exact copy anywhere, or a near copy (case, whitespace, line endings, more than half the long lines) | `src/shared/stage-gate.ts` |
| Mirror names | `assertNoMirrorReference` with `mirrorDenyList` (origin URL, `owner/name`, Pages URL, repo name, `venfork`) on branch name, author, committer, message, PR and issue title/body; `MirrorReferenceError` | `src/shared/deny-list.ts` |
| Internal blocks | `stripInternalBlocks` on PR and issue bodies and titles; `RedactionError` on a broken marker; marker-shaped text in files and messages is refused even with `VENFORK_ALLOW_SELF_REFERENCE=1` | `src/shared/redaction.ts` |
| Bot commits and tags | stage refuses commits authored or committed by `venfork-bot`; pushes with `--no-follow-tags` | `src/shared/stage-gate.ts`, `src/commands/stage.ts` |
| Pushes to upstream from the clone | `upstream` push URL is `DISABLE`; only no-public stage pushes upstream, by URL | `src/commands/setup.ts`, `src/commands/stage.ts` |

## How to prove each one holds

```bash
venfork schedule set "0 * * * *" </dev/null >/dev/null 2>&1
vf_origin_commit docs/INTERNAL.md "$(printf 'internal plan line one is long enough\nsecond internal line also long enough\nthird internal line also long enough')"
venfork preserve add docs/INTERNAL.md </dev/null >/dev/null 2>&1; venfork sync </dev/null >/dev/null 2>&1
git -C "$VF_PUBLIC" ls-tree -r --name-only main | grep -c -e venfork-sync -e INTERNAL     # 0: public is upstream
git fetch -q origin
git checkout -q -b c1 origin/main && cp docs/INTERNAL.md src/notes.md && git add . && git commit -qm "docs: notes"
venfork stage c1 </dev/null 2>&1 | grep -o "Refusing to stage.*"          # content of docs/INTERNAL.md
git checkout -q -b c2 upstream/main && mkdir -p .venfork && echo '{}' > .venfork/x.json && git add . && git commit -qm "chore: x"
venfork stage c2 </dev/null 2>&1 | grep -o "Refusing to stage.*"          # mirror-only path .venfork/x.json
git checkout -q -b c3 upstream/main && echo r > src/r.txt && git add . && git commit -qm "see $VF_ORIGIN"
venfork stage c3 </dev/null 2>&1 | grep -o "Refusing to publish.*"        # message contains the origin path
git checkout -q -b c4 origin/main && echo c > src/c.txt && git add . && git commit -qm "feat: c"
vf_yes stage c4 >/dev/null 2>&1                                              # cut from origin/main, carries the managed commit
git -C "$VF_PUBLIC" ls-tree -r --name-only c4 | grep -c -e venfork-sync -e INTERNAL   # 0: managed commit dropped
git -C "$VF_PUBLIC" log --format='%an%n%cn%n%B' main..c4 | grep -ci -e venfork -e "$VF_ORIGIN"   # 0
for b in c1 c2 c3; do git -C "$VF_PUBLIC" rev-parse -q --verify "refs/heads/$b" || echo "$b absent"; done
git remote get-url --push upstream                                          # DISABLE
```

Internal blocks cannot be driven end to end on the fixture (they need gh). Prove the function and read the e2e result:
`(cd "$(dirname "$VF_CLI")/.." && bun -e "import { stripInternalBlocks } from './src/shared/redaction.ts'; console.log(stripInternalBlocks('a <!-- venfork:internal -->x<!-- /venfork:internal --> b'))")` prints `a  b`.

## What usually lies

- The fixture origin is a local path, so the deny-list has no `owner/name` and no repo-name term. Those terms are proven only by `tests/integration/deny-list.test.ts` and `tests/integration/stage-gate-content.test.ts`.
- A refusal message alone is not the proof. Check that `$VF_PUBLIC` has no ref for the branch.
- The gate does not decode gzip, zip, base64 or UTF-32. A leak in that form passes; no test claims otherwise.
- Text outside `<!-- venfork:internal -->` markers in a PR or issue body is published as is. The preview is the only guard.

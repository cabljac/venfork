# Feature map

One file per `src/commands/<name>.ts`. Open only the file for the command you changed.

| File | CLI | Needs GitHub for success |
|---|---|---|
| `setup.md` | `venfork setup` | yes |
| `clone.md` | `venfork clone` | yes |
| `sync.md` | `venfork sync [branch]` | no |
| `schedule.md` | `venfork schedule` | no |
| `stage.md` | `venfork stage [branch] <name>` | only with `--pr` |
| `pull-request.md` | `venfork pull pr` | yes (`sync upstream-pr/<n>` does not) |
| `issue.md` | `venfork stage issue`, `venfork pull issue` | yes |
| `doctor.md` | `venfork doctor` | no (gh checks skip) |
| `workflows.md` | `venfork workflows` | no |
| `preserve.md` | `venfork preserve` | no |

Cross-cutting: `leak-invariants.md` (what must never reach public or upstream), `multi-command-journeys.md`.

## Conventions in every file

- Every drive starts from `SKILL.md` Launch: `. "$T/vf.env"; cd "$VF_WORK"`. Default branch is `main`.
- `$VF_PUBLIC` is empty with `--no-public`. Stage then pushes to `$VF_UPSTREAM`.
- Exit codes: 0 success, 1 any error (the message prints as `Error: ...` or after a red `■`), 130 a prompt that hit EOF or was cancelled.
- Typed errors live in `src/errors.ts`. The CLI prints only `.message`, so match on the message text.
- "Concurrent lease" drives use a stale copy of origin: fetch from the copy, push to the real origin.

```bash
git clone -q --bare "$VF_ORIGIN" "$VF_ROOT/stale.git"
# ... move the real origin on (vf_origin_commit or another venfork run) ...
git remote set-url origin "$VF_ROOT/stale.git"; git remote set-url --push origin "$VF_ORIGIN"
# drive, then restore:
git remote set-url origin "$VF_ORIGIN"; git config --unset-all remote.origin.pushurl
```

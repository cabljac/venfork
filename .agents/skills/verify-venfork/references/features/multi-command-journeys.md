# Multi-command journeys

Each journey starts from a fresh fixture (`SKILL.md` Launch). Run the steps in order in `$VF_WORK`.
Record the evidence after each step; a journey passes only when every line matches.

## 1. Setup, schedule, sync twice

The fixture stands in for `setup`: it is the layout setup builds (remotes, `DISABLE` push URL, `venfork-config`). Real setup is e2e tier 1.

1. `venfork doctor --json; echo $?` - exit 0, `invariant` "upstream (+0)".
2. `venfork schedule set "0 */6 * * *" </dev/null 2>&1 | grep "Scheduled sync enabled"` - one line. `vf_tip "$VF_ORIGIN" main^` equals `vf_tip "$VF_UPSTREAM"`. `git -C "$VF_ORIGIN" log -1 --format=%an main` is `venfork-bot`.
3. `A=$(vf_tip "$VF_ORIGIN"); N=$(vf_pushes "$VF_ORIGIN")`, then `venfork sync </dev/null` twice. Both runs print `origin/main already up to date` and `public/main already up to date`. `vf_tip "$VF_ORIGIN"` is `$A`; `vf_pushes "$VF_ORIGIN"` is `$N`.
4. `vf_upstream_commit src/new.txt new`, then `venfork sync </dev/null` - prints `Updated origin/main` and `Updated public/main`. `vf_pushes "$VF_ORIGIN"` is `$N + 1`. `vf_tip "$VF_PUBLIC"` equals `vf_tip "$VF_UPSTREAM"`.
5. `venfork sync </dev/null` once more - no push. `venfork doctor --json` - exit 0, `workflow` "up to date".

On a fixture made with the default seed, the managed SHA after step 2 is the same on every machine: the fixture pins its commit dates.

## 2. Stage, then pull it back as an upstream PR

1. `git checkout -q -b feat upstream/main && echo f > src/feat.txt && git add . && git commit -qm "feat: add feat"`.
2. `venfork stage feat </dev/null; echo $?` - 130, and `git -C "$VF_PUBLIC" rev-parse -q --verify refs/heads/feat` fails.
3. `vf_yes stage feat; echo $?` - 0. `git -C "$VF_PUBLIC" rev-parse feat^{tree}` equals `git rev-parse feat^{tree}`.
4. Open the "upstream PR": `git -C "$VF_PUBLIC" push -q "$VF_UPSTREAM" feat:refs/pull/1/head`.
5. `venfork sync upstream-pr/1 </dev/null 2>&1 | grep "synced with upstream PR #1"` - one line. `vf_tip "$VF_ORIGIN" upstream-pr/1` equals `vf_tip "$VF_PUBLIC" feat`.
6. `git -C "$VF_ORIGIN" show venfork-config:.venfork/config.json` has `pulledPrs["upstream-pr/1"].head` at that SHA. `venfork doctor --json | jq .links.pulledPrs` shows it.
7. `venfork sync upstream-pr/1` again - `vf_pushes "$VF_ORIGIN" upstream-pr/1` does not change.

## 3. Preserve, sync, upstream adopts the file, sync to +0

Keep the schedule off, so the preserved file is the only managed content.

1. `vf_origin_commit docs/INTERNAL.md "mirror version"`.
2. `venfork sync </dev/null` - exit 1, `Sync aborted to prevent data loss: origin/main has 1 commit(s)`. Origin is unchanged.
3. `venfork preserve add docs/INTERNAL.md </dev/null` - exit 0. `main` has not moved yet.
4. `venfork sync </dev/null` - exit 0. `git -C "$VF_ORIGIN" show --stat --format=%s main` is the managed commit with only `docs/INTERNAL.md`. `git -C "$VF_PUBLIC" ls-tree -r --name-only main | grep -c INTERNAL` is 0.
5. `vf_upstream_commit docs/INTERNAL.md "upstream version"`.
6. `venfork sync </dev/null` - exit 0. `vf_tip "$VF_ORIGIN"` equals `vf_tip "$VF_UPSTREAM"` (+0). `git -C "$VF_ORIGIN" show main:docs/INTERNAL.md` is `upstream version`.
7. `N=$(vf_pushes "$VF_ORIGIN")`; `venfork sync </dev/null`; `vf_pushes "$VF_ORIGIN"` is `$N`. `venfork doctor --json` - `invariant` "upstream (+0)".

## 4. A teammate pushes to main while a sync runs

1. `venfork schedule set "0 * * * *" </dev/null` and `vf_upstream_commit src/x.txt x`.
2. `git clone -q --bare "$VF_ORIGIN" "$VF_ROOT/stale.git"`, then `vf_origin_commit src/team.txt team`; `TEAM=$(vf_tip "$VF_ORIGIN")`.
3. `git remote set-url origin "$VF_ROOT/stale.git"; git remote set-url --push origin "$VF_ORIGIN"`.
4. `venfork sync </dev/null` - exit 1, "origin/main moved since this sync fetched it". `vf_tip "$VF_ORIGIN"` is `$TEAM`.
5. Restore: `git remote set-url origin "$VF_ORIGIN"; git config --unset-all remote.origin.pushurl`. `venfork sync </dev/null` - exit 1, `SyncDivergenceError` naming `src/team.txt`. `venfork doctor --json` - `divergence` false.

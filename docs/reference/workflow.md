# Workflow, layout and troubleshooting

A complete day-to-day workflow, the repository layout, git remotes and fixes for common errors.

## Complete Workflow

### Initial Setup

```bash
# Clone and configure the repos (personal account)
venfork setup git@github.com:client/awesome-project.git

# Or for organization
venfork setup git@github.com:client/awesome-project.git --org acme-corp

# Navigate to private mirror
cd awesome-project-private

# Check the mirror
venfork doctor

# Or verify remotes manually
git remote -v
# With personal account:
# origin    git@github.com:you/awesome-project-private.git (private)
# public    git@github.com:you/awesome-project.git (public fork)
# upstream  git@github.com:client/awesome-project.git (read-only)

# With organization:
# origin    git@github.com:acme-corp/awesome-project-private.git (private)
# public    git@github.com:acme-corp/awesome-project.git (public fork)
# upstream  git@github.com:client/awesome-project.git (read-only)
```

### Daily Development

```bash
# Sync default branches with upstream (optional, keeps main up-to-date)
venfork sync

# Create feature branch
git checkout -b feature/user-auth

# Make changes, commit
git add .
git commit -m "Add user authentication"

# Push to private mirror
git push origin feature/user-auth

# Create PR in private repo for team review
# Review happens internally, invisible to client
```

### Internal Review Process

```bash
# Team reviews PR in private repo
# Experiment, iterate, refine approach
# All feedback and changes stay private

# Address review feedback on the same branch
git commit -m "Address review feedback"
git push origin feature/user-auth
```

Do not merge the feature branch into the mirror's `main`. `main` follows upstream only, so the next `venfork sync` (and every scheduled run) aborts on a commit that upstream does not have. The approved branch stays a branch, and you stage it from there.

### Staging for Upstream

```bash
# When ready to contribute back
venfork stage feature/user-auth

# Stage asks "Push to public fork and open the upstream PR?", then pushes the
# branch to the public fork and opens the upstream PR with the internal review
# PR's body (venfork:internal blocks removed). The output ends with:
#   Upstream PR: https://github.com/client/awesome-project/pull/123
#   Internal review: https://github.com/you/awesome-project-private/pull/7

# NOW visible to client
```

To push the branch without opening the PR, run `venfork stage feature/user-auth --no-pr`. Stage then prints the compare link, and you open the PR yourself.

## Repository Structure

```
┌─────────────────────────────────────────────┐
│  Upstream (client/project)                  │
│  • Original repository                      │
│  • Read-only for you                        │
└──────────────────┬──────────────────────────┘
                   │
                   │ fork
                   ▼
┌─────────────────────────────────────────────┐
│  Public Fork (you/project or org/project)   │
│  • Visible to everyone                      │
│  • Staging area for PRs                     │
│  • Only pushed to via `venfork stage`       │
└──────────────────┬──────────────────────────┘
                   │
                   │ mirror (disconnected)
                   ▼
┌─────────────────────────────────────────────┐
│  Private Mirror (you/project-private)       │
│                  (or org/project-private)   │
│  • Only visible to your team                │
│  • Safe space to experiment & iterate       │
│  • Internal PRs and reviews                 │
│  • Your daily work happens here             │
│  • Contains venfork-config branch           │
└─────────────────────────────────────────────┘
```

## Configuration

### Git Remotes

After `venfork setup`, your local repository has three remotes:

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `you/project-private` (or `org/project-private`) | Private work (default) |
| `public` | `you/project` (or `org/project`) | Stage for upstream |
| `upstream` | `original/project` | Sync with latest |

**Note:** When using `--org`, all repos are created under the specified organization.

### Default Behavior

- `git push` → Pushes to `origin` (private mirror)
- `git pull` → Pulls from `origin` (private mirror)
- `venfork sync` → Updates default branches of `origin` and `public` to match `upstream`
- `venfork stage` → Pushes to `public`

## Troubleshooting

### Check Your Setup

If you encounter issues, run `venfork doctor` first. It checks the remotes, the layout mode, the managed-commit invariant, divergence, preserved files, the sync workflow, the git transport, the push token and the last scheduled run, and prints a fix for each failing check.

### "GitHub CLI is not authenticated"

Run `gh auth login` and follow the prompts to authenticate.

### "Not in a git repository"

Make sure you're inside the cloned vendor repository directory. Run `venfork doctor` to verify.

### "Remote not found" (origin/public/upstream)

This usually means setup never finished for this clone, or the clone is not the private mirror.
- Run `venfork doctor` to see which remotes are missing
- Re-run **`venfork setup <same-upstream-url>`** from an empty parent directory (or a directory where the private mirror folder doesn’t conflict) so remotes and config can be repaired, or use **`venfork clone`** on the private mirror URL instead

### Divergent Commits Warning

`venfork doctor` lists divergent commits and the files they touch. If `venfork sync` detects commits on your default branch that aren't in upstream:
1. This suggests work was committed directly to main/master (not recommended)
2. Sync will abort to prevent losing these commits
3. To preserve: manually rebase or cherry-pick them to a feature branch
4. To force sync anyway: `git push origin upstream/main:main -f` (loses commits)

### Branch Already Exists on Public Fork

If you've staged a branch before and need to update it, run `venfork stage <branch>` again. Stage rebuilds the branch and replaces the public copy with `--force-with-lease`. Do not push the branch to the public fork with plain `git push`: that skips the checks stage runs (see [`venfork stage`](commands.md#venfork-stage-branch---no-pr---draft---dry-run---title-text---base-branch---internal-pr-n---no-update-existing---yes---no-input---json)).

# Scheduled sync

Sync the mirror on a schedule with GitHub Actions: tokens, the GitHub App, failures and upgrades.

### `venfork schedule <status|set <cron> [--app|--token]|disable> [--yes] [--no-input] [--json]`

Manage automated sync configuration stored in `venfork-config`. With `--json`, every action prints one JSON envelope on stdout with the schedule after the action (see [JSON output](json.md#json-output)).

- `--no-input` - Never prompt. `schedule` asks nothing, so it changes nothing; it is accepted so a wrapper can pass one fixed flag set. See [Non-interactive use](headless.md#non-interactive-use).

**Examples:**
```bash
venfork schedule status
venfork schedule set "0 */6 * * *"
venfork schedule set "0 */6 * * *" --app   # push with a GitHub App token
venfork schedule disable
```

The cron is five fields. Month and weekday names (`JAN`, `MON-FRI`) are accepted in any case in lists and ranges, and are written to the workflow as you typed them. Names are not valid as a step (`*/MON`) or as the lone base of a step (`MON/2`).

**What it does:**
1. Stores schedule state (`enabled`, `cron`) and, with `--app`, `scheduleAuth` in `.venfork/config.json` on `venfork-config`
2. `set` and `disable` re-stamp the private mirror default branch the same way `venfork sync` does: upstream plus at most one managed commit, with `.github/workflows/venfork-sync.yml` added (`set`) or removed (`disable`). Like sync, they refuse when origin has commits that upstream does not have.

**When a scheduled sync fails**

The workflow runs `venfork sync --report-issues` with the job's `GITHUB_TOKEN` (the workflow asks for `issues: write`). If sync is blocked by divergent commits, it opens an issue on the mirror labelled `venfork-sync-blocked`, or refreshes the body of the open one, with the changed files and the exact `venfork keep add ...` or rebase steps. A final `if: failure()` step covers every other failure (install errors, a missing token, timeouts) by opening the same labelled issue or commenting on it with the run URL. The next successful sync comments "Resolved by <run>" and closes the issue. If you close the issue by hand while the divergence is still there, the next blocked run opens a new one. Outside GitHub Actions, `--report-issues` only files the issue when gh confirms the mirror is a private repository.

The workflow runs one sync at a time (concurrency group `venfork-sync-<workflow name>`, queued, not cancelled) and stops a run after 30 minutes. It installs venfork before checking out the mirror, with `npm install -g --ignore-scripts`, so no install script runs with the push token in the git config. Before that it sets up Node.js 22 with `actions/setup-node` (pinned by commit), so the run does not depend on the Node the runner image ships.

**Pinned venfork version**

By default the generated workflow installs exactly the venfork version that wrote it (`npm install -g venfork@<version>`). The runner therefore regenerates byte-identical YAML and the managed commit stays stable. To upgrade a mirror, install the new venfork locally and run `venfork sync` (or `venfork schedule set` again). That rewrites the workflow with the new pin in one managed-commit update. Check the installed version with `venfork --version`.

To install something else, set the `VENFORK_INSTALL_SPEC` repository variable on the mirror. The workflow passes its value to `npm install -g` in place of `venfork@<version>`. The workflow accepts only `venfork@<semver>` or an `https://` URL ending in `.tgz`, and fails the install step with an error for anything else. Git specs do not work: a git install has no built `dist/` and no `venfork` binary.

```bash
gh variable set VENFORK_INSTALL_SPEC --repo <owner>/<mirror> --body "venfork@<version>"
```

Keep `VENFORK_INSTALL_SPEC` unset, or equal to the venfork version you run locally. The runner regenerates the YAML with the version it installed, so a different version makes local and runner syncs rewrite the managed commit back and forth. The spec must install venfork 0.11.0 or later, the first release that understands `sync --report-issues`. Sync also refuses to run when origin pins a newer venfork than the CLI you are running; upgrade the CLI instead of downgrading the pin.

**Authenticating cross-repo pushes**

Set a `VENFORK_PUSH_TOKEN` secret on the **private mirror** in both modes. The default `GITHUB_TOKEN` inside the workflow cannot do two things a scheduled run needs:

- push to the public fork (standard mode), because it is scoped to the mirror only;
- push upstream commits that change files under `.github/workflows/`. GitHub rejects that push with `refusing to allow a GitHub App to create or update workflow ... without workflows permission`. The e2e suite (tier 6) reproduces this on a no-public mirror.

Create a **fine-grained personal access token** limited to the mirror (and the public fork in standard mode) with Contents: read and write and Workflows: read and write, and store it as the secret (to avoid a long-lived token, use a GitHub App instead, as the next section shows):

```bash
gh secret set VENFORK_PUSH_TOKEN --repo <owner>/<mirror> --body "<fine-grained token>"
```

Do not store `gh auth token` or any other account-wide token. A repository secret is readable by every workflow on the mirror's default branch, and until you filter them with `venfork workflows block` or `venfork workflows allow`, every workflow upstream ships runs there. An upstream contributor who lands a workflow change could read the secret, so give it access to nothing beyond the repositories sync pushes to. `venfork schedule set` and `venfork doctor` warn while both workflow lists are empty.

If you followed the 0.10 docs and stored `VENFORK_PUSH_TOKEN` from `gh auth token`, rotate it: revoke that token and store a fine-grained one as above. `venfork doctor` only checks that the secret exists, so it cannot tell you which kind it holds.

If `VENFORK_PUSH_TOKEN` is unset, the generated workflow fails its first step with an error annotation, before it installs anything. The failure opens the `venfork-sync-blocked` issue, and the issue names the missing secret. The workflow does not fall back to the default `GITHUB_TOKEN`.

**Authenticating with a GitHub App**

Instead of a personal access token, the workflow can mint a token from a GitHub App on each run. The token expires after one hour, and you never rotate a 90-day PAT. Create one App per mirror (per client), not one per owner:

1. Create a GitHub App under the account or organization that owns the mirror (Settings, Developer settings, GitHub Apps). Turn the webhook off. Give it the repository permissions Contents: read and write and Workflows: read and write. Metadata: read is added for you. It needs no Issues permission: issue reports use the job token.
2. Install the App on only this mirror and, in standard mode, its public fork. Do not install it on other mirrors.
3. Generate a private key for the App and note its client ID.
4. Store both as secrets on the mirror, then switch the schedule to App auth:

```bash
gh secret set VENFORK_APP_CLIENT_ID --repo <owner>/<mirror> --body "<client ID>"
gh secret set VENFORK_APP_PRIVATE_KEY --repo <owner>/<mirror> < <private-key>.pem
venfork schedule set "0 */6 * * *" --app
```

`--app` is recorded as `scheduleAuth` in `venfork-config`, so a later `venfork schedule set` keeps it, and so do `disable` and every clone. `venfork schedule set "<cron>" --token` switches back to `VENFORK_PUSH_TOKEN`. Each switch rewrites the workflow in the managed commit, the same way a version upgrade does.

In app mode, the first step checks that both secrets are set and fails with an error annotation otherwise. A later step runs `actions/create-github-app-token`, pinned by commit SHA, to mint a token for the mirror (and the public fork) with only Contents and Workflows write. Checkout pushes with that token. When the mint fails, the `venfork-sync-blocked` issue says to check the installation and the key.

Caveats:

- The private key is as sensitive as a token and does not expire. Every upstream workflow on the mirror can read a repository secret, so filter them with `venfork workflows block` or `venfork workflows allow`.
- `VENFORK_APP_PRIVATE_KEY` can mint a token for every repository the App is installed on. The workflow's `repositories:` input limits only the token the workflow mints, not the key. If several mirrors share one App, one mirror's secret gives write access to every mirror. Use one App per mirror.
- One installation token covers one owner. The mirror and the public fork must have the same owner. `schedule set --app` refuses otherwise, and so does the workflow.
- A private upstream needs a push credential that can also read the upstream, because the runner fetches it with the same token. The minted App token covers only the mirror and the public fork, so app mode cannot fetch a private upstream. With `--token`, a fine-grained PAT covers repositories of one owner only: it works when the upstream has the mirror's owner and the PAT includes it. For a private upstream under another owner, `VENFORK_PUSH_TOKEN` must be a classic PAT with `repo` scope.
- `actions/create-github-app-token` v3 needs a runner on Node 24 (Actions runner 2.327.1 or later). `ubuntu-latest` qualifies; check self-hosted runners.
- `venfork doctor` can only see that the secrets exist. It cannot check the key or the installation, so watch its `last-run` check after you switch.

### How scheduled sync behaves

- **Cron is best-effort.** GitHub runs scheduled workflows only from the default branch, at most every 5 minutes, and may delay or skip runs when Actions is busy. Do not rely on exact timing. `venfork doctor` flags a disabled workflow, and a last scheduled run older than twice the cron interval (at least 1 hour).
- **Idle repositories.** GitHub disables scheduled workflows in a public repository after 60 days without activity. A private mirror is not affected by that rule, but if you make a mirror public, re-enable the workflow from the Actions tab when it stops.
- **The workflow file must stay on the default branch.** It lives in the venfork-managed commit. Sync builds the new tip first and moves the default branch in a single leased push, so the file is never missing between runs.
- **Token.** Both modes need a push credential, because the job token cannot push upstream workflow changes, nor push to the public fork. By default that is the `VENFORK_PUSH_TOKEN` secret, a fine-grained token with Workflows: write limited to the mirror and the public fork. With `--app` it is a one-hour token minted from the `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` secrets (see above). A run without its secrets fails at its first step and opens the `venfork-sync-blocked` issue. `venfork doctor` also checks that the secrets exist.
- **Failures open an issue.** Blocked or failed runs open or update a `venfork-sync-blocked` issue on the mirror; the next successful run closes it.
- **Upgrades.** The workflow pins the venfork version that wrote it. Install a newer venfork locally and run `venfork sync` to move the mirror to it.
- **Right after a release.** A release tag can exist for a few minutes before `npm publish` finishes. A local sync in that window can pin a version that npm does not have yet. The scheduled run then fails at "Install venfork" and opens the `venfork-sync-blocked` issue. The next run after the publish succeeds and closes it. To bridge the gap, set `VENFORK_INSTALL_SPEC` (see above).

Upgrading a mirror made by venfork 0.10 or earlier is in [migration.md](migration.md).

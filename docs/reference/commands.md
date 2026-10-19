# Command reference

Every command, its flags and what it does. The README front page lists the commands; this page has the detail.

### `venfork setup <upstream> [name] [--org <organization>] [--fork-name <repo>] [--own-upstream] [--yes] [--no-input] [--json]`

Creates the complete vendor workflow setup (with `--json`, setup never prompts and prints one JSON envelope on stdout; see [JSON output](json.md#json-output)):

**`<upstream>`** may be a full GitHub clone URL (SSH or HTTPS) or **shorthand** `owner/repo` (e.g. `invertase/react-native-firebase`), which is treated like `git@github.com:owner/repo.git`.

**`--fork-name`** sets the **public fork’s repository name** under your chosen owner/org (passed through to `gh repo fork --fork-name`). Use this when **upstream already lives under the same org** you pass to `--org`: GitHub cannot create a second repo with the same name, so the fork must use a different name (e.g. `my-lib-public` while upstream is `my-lib`).

**`--own-upstream`** skips the public-fork hop entirely. Only `origin` (private mirror) and `upstream` are configured; `venfork stage` later pushes branches **directly to upstream** and opens an intra-upstream PR (unless `--no-pr`). Use this when you **own the upstream** repo (no client to hide work from): it removes a redundant fork-and-stage round-trip. Mutually exclusive with `--fork-name`.

**What it creates:**
- **Private mirror** (`yourname/project-private` or `org/project-private`) - For internal work
- **Public fork** (`yourname/project` or `org/project`, or the name from **`--fork-name`**) - For staging to upstream *(skipped with `--own-upstream`)*
- **Config branch** (`venfork-config`) - Stores remote URLs (and `mode: 'no-public'` when applicable) for easy team cloning
- **Local clone** with remotes configured:
  - `origin` → private mirror (default push/pull)
  - `public` → public fork (for staging) *(omitted with `--own-upstream`)*
  - `upstream` → original repo (read-only, push disabled)

**Arguments:**
- `upstream` - GitHub repository URL (SSH or HTTPS), or shorthand `owner/repo`
- `name` - (Optional) Name for private mirror repo (default: `{repo}-private`)
- `--org <organization>` - (Optional) Create repos under organization instead of personal account
- `--fork-name <repo>` - (Optional) Public fork repo name under that org/user (default: same basename as upstream)
- `--own-upstream` - (Optional) Skip the public-fork hop; stage pushes directly to upstream
- `--yes`, `-y` - (Optional) Answer the personal-account confirm with yes. `--org <your username>` (compared with your gh login ignoring case) also counts as consent: the repos go under your personal account with no confirm. `VENFORK_ORG` set to your username does not: it is ambient, so the confirm still runs (and needs `--yes` without a terminal).
- `--no-input` - (Optional) Never prompt. A missing `name` defaults to `{repo}-private` (the choice is logged on stderr). A missing `upstream`, or a personal account without `--yes`, exits 2. See [Non-interactive use](headless.md#non-interactive-use).

**Examples:**
```bash
# Personal account (default)
venfork setup git@github.com:vercel/next.js.git
# Shorthand (same as git@github.com:vercel/next.js.git)
venfork setup vercel/next.js
# Creates: yourname/next.js-private (private), yourname/next.js (public fork)

venfork setup https://github.com/vuejs/vue.git vue-internal
# Creates: yourname/vue-internal (private), yourname/vue (public fork)

# Organization account
venfork setup git@github.com:client/awesome-project.git --org acme-corp
# Creates: acme-corp/awesome-project-private (private), acme-corp/awesome-project (public fork)

venfork setup git@github.com:client/project.git internal-mirror --org my-company
# Creates: my-company/internal-mirror (private), my-company/project (public fork)

# Upstream is already my-org/foo - fork under my-org with a different public repo name
venfork setup my-org/foo my-foo-private --org my-org --fork-name foo-public
# Creates: my-org/my-foo-private (private), my-org/foo-public (public fork), upstream = my-org/foo

# Shorthand also works with --org + --fork-name (equivalent to git@github.com:firebase/extensions.git)
venfork setup firebase/extensions firebase-extensions-private --org invertase --fork-name firebase-extensions

# Upstream is already in your org and there is no public-vs-private audience to maintain
# so skip the fork hop entirely. `stage` will push directly to my-org/foo and open an intra-repo PR.
venfork setup my-org/foo my-foo-private --org my-org --own-upstream
# Creates: my-org/my-foo-private (private), upstream = my-org/foo. No public fork.
```

**Re-running setup (repos already on GitHub):** Run the same command again if you need a fresh local clone, remote fixes, or an updated `venfork-config` branch. Venfork uses `gh repo view` to detect a public fork or private mirror that already exists when `gh repo fork` or `gh repo create` fails, then:

- Skips seeding a **new** private mirror from upstream (no duplicate initial push).
- Clones the private mirror into `./<private-mirror-name>`, or **reuses** that directory if it is already a git repo whose `origin` points at the expected mirror URL.
- Ensures `public` and `upstream` remotes exist and point at the right URLs (adds or corrects them).
- Pushes the `venfork-config` branch again so teammates get current URLs.
- If **either** GitHub repo was already present, runs **`venfork sync` inside that clone** so defaults are normalized from `upstream` (subject to divergence safeguards): `public` matches upstream, while `origin` may include one managed workflow commit when scheduled sync is enabled.

Pure failures (for example name taken by a **different** repo) still abort setup. If recovery sync stops due to divergent default branches, fix or move those commits, then run **`venfork sync`** again from inside the private mirror.

### `venfork clone <mirror> [--own-upstream] [--upstream <url>] [--public-fork <url>] [--yes] [--no-input] [--json]`

Clone an existing vendor setup and automatically configure all remotes. With `--json`, clone never prompts and prints one JSON envelope on stdout (see [JSON output](json.md#json-output)).

**`<mirror>`** is the private mirror: full GitHub URL or shorthand `owner/repo`.

**What it does:**
- Clones the private mirror repository
- **Reads venfork-config branch** for layout (`mode`) and URLs (if available)
- Falls back to auto-detection when the config branch is absent:
  - Public fork (by stripping `-private` suffix)
  - Upstream repository (from public fork's parent)
- Configures the appropriate remotes (origin/upstream, plus public in standard mode)
- Disables push to upstream (read-only)

**Options** (only meaningful for **legacy mirrors** without a `venfork-config` branch. When config is present it is authoritative: a flag that names the recorded value is accepted, and a flag that contradicts it is an error):
- `--own-upstream` - The mirror has no public fork (origin + upstream only). Use when the original setup was created with `venfork setup --own-upstream` but the config branch is missing.
- `--upstream <url>` - Provide the upstream explicitly, as a GitHub URL or `owner/repo` (anything else exits 2). Useful with `--own-upstream` (no public fork to derive it from) or to skip the auto-detect prompt.
- `--public-fork <url>` - Provide the public fork (GitHub URL or `owner/repo`) explicitly. Skips the public-fork detection and prompt; upstream is still read from the fork's parent unless `--upstream` is given. Cannot be combined with `--own-upstream`.

`--no-input` never prompts: a URL that clone would ask for exits 2 and names the flag that supplies it. `clone` accepts `--yes` like every command, but has nothing to confirm, so it changes nothing. A clone that fails or is cancelled after the repository was cloned removes the cloned directory, so you can rerun it with the named flag.

**Use this when:**
- A teammate has already run `venfork setup`
- You need to clone an existing vendor setup
- You want automatic remote configuration

**Arguments:**
- `mirror` - GitHub URL or `owner/repo` of the private mirror

**Examples:**
```bash
# Clone existing vendor setup (personal account)
venfork clone git@github.com:yourname/project-private.git
venfork clone yourname/project-private
# Reads config from venfork-config branch (if available)
# Or auto-detects: public fork at yourname/project

# Clone organization vendor setup
venfork clone git@github.com:acme-corp/awesome-project-private.git
# Reads config from venfork-config branch (if available)
# Or auto-detects: public fork at acme-corp/awesome-project
```

**Interactive prompts:**
- If public fork cannot be auto-detected, you'll be prompted for the URL
- If upstream cannot be auto-detected (no parent), you'll be prompted for the URL
- An empty answer is rejected and the prompt asks again; cancelling a prompt (Ctrl-C) exits 130
- Without a terminal (see [Non-interactive use](headless.md#non-interactive-use)) these prompts exit 2 instead and name the flag: `--public-fork <url>` for the public fork, `--upstream <url>` for upstream. Use `--own-upstream --upstream <url>` when the mirror has no public fork

### `venfork sync [--report-issues] [--yes] [--no-input] [--json]`

With `--json`, sync prints one JSON envelope on stdout (see [JSON output](json.md#json-output)).

Update default branches from upstream. With scheduled sync or a preserve list enabled, the private mirror's default branch is upstream plus at most one venfork commit:
- `public/<default>` matches `upstream/<default>`
- `origin/<default>` is `upstream/<default>` plus at most one deterministic managed commit (the sync workflow and preserved files). If that commit would add nothing, `origin/<default>` equals `upstream/<default>`.
- The managed commit's SHA depends only on the upstream tip and its content, so a sync with nothing new to bring in pushes nothing and teammates never see a rewritten default branch.

Normally you run this from your private mirror directory (or any subfolder of that repo). The same behavior is also used internally when **`venfork setup`** completes in recovery mode (existing GitHub repos), using the new clone’s path automatically.

Sync takes no branch: it always syncs upstream's default branch (auto-detected, usually `main` or `master`). `venfork sync <branch>` is a usage error (exit 2); to refresh a pulled upstream PR, run `venfork pull pr <n>` again.

**Flags:**
- `--report-issues` - Open or refresh a `venfork-sync-blocked` issue on the mirror when sync is blocked, and close it after a successful sync. The scheduled workflow passes this flag (see "When a scheduled sync fails" in [`venfork schedule`](scheduled-sync.md#venfork-schedule-statusset-cron---app--tokendisable---yes---no-input---json))
- `--no-input` - Never prompt. `sync` asks nothing, so it changes nothing; it is accepted so a wrapper can pass one fixed flag set. See [Non-interactive use](headless.md#non-interactive-use).

**Examples:**
```bash
venfork sync           # Sync default branches with upstream
```

**What it does:**
1. Fetches latest changes from all remotes (upstream, origin, public)
2. Checks for divergent commits and aborts if any are found, to prevent data loss
3. Builds the new origin tip: upstream's default branch, plus (when scheduled sync, preserve or a workflow allow/block list is enabled) one deterministic managed commit with `.github/workflows/venfork-sync.yml` and preserved files
4. Pushes origin and public once each with an explicit lease, skipping any remote that is already up to date
5. If workflow policy is configured, that managed commit filters `.github/workflows` using:
   - `enabledWorkflows` allowlist (highest precedence)
   - otherwise `disabledWorkflows` blocklist
6. **Does not affect your current working branch or feature branches**

**Important:**
- With scheduled sync or preserve enabled, mirror default branch follows the `upstream + at most 1 managed commit` model
- After upgrading venfork, the first sync rewrites the managed commit once (new trailer and dates); later syncs are stable
- Public default branch remains aligned with upstream
- Your current work on feature branches is completely unaffected
- If divergent commits are detected, sync will abort to prevent data loss
- The managed commit is built from git trees on a temporary index, never from your working copy, so sparse-checkout, hooks, clean filters and `core.quotePath` do not change it
- Workflow allow/block entries match file basenames exactly (no glob patterns)
- A preserved file that upstream adds is replaced by upstream's version. If upstream later deletes that path again, sync keeps the last version the mirror carried (upstream's last version), because it is still on the previous mirror tip. Run `venfork keep remove <path>` to let it go

### `venfork stage <branch> [--no-pr] [--draft] [--dry-run] [--title <text>] [--base <branch>] [--internal-pr <n>] [--no-update-existing] [--force] [--yes] [--no-input] [--json]`

Push a branch to the public fork, making it visible and ready for PR to upstream. `venfork stage branch <name>` is the explicit form of the same command; use it for a branch named `issue`, `approval` or `branch`. It also opens the upstream PR for you using your internal review PR's body, unless you pass `--no-pr`. With `--json`, stage never prompts and prints one JSON envelope on stdout (see [JSON output](json.md#json-output)).

**⚠️ Important:** This is when your work becomes visible to the client!

**Arguments:**
- `branch` - Branch name to stage

**Flags:**
- By default stage also opens the upstream PR. It looks up your internal-review PR on the private mirror and copies its description (with redacted blocks stripped).
- `--no-pr` - Push the branch only and print the compare link. `--draft`, `--title`, `--internal-pr` and `--no-update-existing` need the PR, so they are usage errors with `--no-pr`; `--base` still sets the compare link. `--pr` is still accepted for one release and changes nothing.
- `--draft` - Open the upstream PR as a draft.
- `--dry-run` - Run every check, rebuild the branch and build the upstream PR title and body after redaction, print them, and stop. Nothing is pushed, no PR is opened or edited, and nothing is recorded. It needs no `--yes`. With the default PR it still reads the internal review PR through gh, and it looks for an open upstream PR for the branch: when one is open, the preview shows that a real stage keeps its title and replaces only its body (or, with `--no-update-existing`, leaves it unchanged). `--dry-run --no-pr` does not use GitHub beyond the fetch.
- When the mirror's approval level is not `off`, stage first checks for an approving review on the branch's mirror PR and publishes exactly the approved head (see [`venfork stage approval`](#venfork-stage-approval-onreviewedtwo-personoff---yes---no-input---json)).
- A branch with no commits to publish beyond upstream's default branch is refused (`precondition`, "Nothing to stage"). Merge commits and venfork-managed commits do not count: stage drops them.
- `--title <text>` - Override the upstream PR title (default: the internal PR title, or the branch name if no internal PR was found).
- `--base <branch>` - Override the upstream base branch (default: upstream's default branch).
- `--internal-pr <n>` - Pin a specific internal-review PR number (skips the most-recent-open lookup). Useful when multiple PRs target the same branch.
- `--no-update-existing` - Do not update an already-open upstream PR body when staging.
- `--force` - Stage past an approval gate refusal (see [`venfork stage approval`](#venfork-stage-approval-onreviewedtwo-personoff---yes---no-input---json)). A person must confirm the bypass at a terminal; `--yes` does not answer that confirm. Not with `--dry-run`. By default, if an upstream PR for the branch already exists, `venfork stage` refreshes its body with the latest translated content.
- `--yes`, `-y` - Answer the "Push to public fork and open the upstream PR?" (no-public: "Push to upstream and open the PR?") confirm with yes. With `--no-pr` the confirm is "Push to public fork?" (or "Push to upstream?"). Required when venfork cannot prompt.
- `--no-input` - Never prompt. Without `--yes`, the confirm exits 2 and nothing is pushed. See [Non-interactive use](headless.md#non-interactive-use).

**Examples:**
```bash
# Push only, no PR
venfork stage feature-auth --no-pr

# See what would be published, push nothing
venfork stage feature-auth --dry-run

# Stage and open the upstream PR using the internal review body
venfork stage feature-auth

# Open as draft
venfork stage feature-auth --draft

# Override title or base
venfork stage feature-auth --title "Add OAuth"
venfork stage feature-auth --base develop

# From a script or CI: confirm up front
venfork stage feature-auth --yes
```

**What it does (with `--no-pr`, and before the PR):**
1. Refuses branches that are not upstream work: upstream's default branch, anything that is not a local branch (tags, remote-tracking refs), `venfork-config`, and a branch with no history in common with upstream. Like sync, it also refuses while the preserve list holds entries venfork no longer accepts, and names the `venfork keep remove` command for each.
2. Fetches upstream and origin, then rebuilds the branch as a linear history on `upstream/<default>`: every non-merge commit is cherry-picked in order and venfork-managed commits are dropped. Merge commits never ship (a merge with a manual conflict resolution is refused, since dropping it would lose work). The rebuilt commits get new SHAs even when the branch was already based on upstream.
3. Checks every rebuilt commit before anything is pushed and refuses the branch when a commit:
   - adds or changes `.github/workflows/venfork-sync.yml`, anything under `.venfork/`, or a preserved path (unless the result is exactly upstream's file at that path). Deleting a preserved file is allowed.
   - adds a file whose content is identical to a preserved file on the mirror, at any path (catches renames and copies). The check covers every earlier version of a preserved file that the clone still knows and every earlier version of the venfork config: the mirror refs, their reflog entries and the history of both that upstream does not contain (up to 20000 commits and 20000 reflog entries per ref). A version that upstream itself has published at the same path is not mirror content. When a ref has more than 20000 reflog entries, or that history holds more than 20000 commits, stage refuses, because the older mirror-only history cannot be checked: stage from a clone whose reflog is shorter (a fresh clone has almost none), or, after confirming no mirror-only history older than that is needed, drop old entries with `git reflog expire --expire=<date> --all`. There is no override.
   - adds a text file that is a near copy of a preserved file, the managed workflow or the venfork config: the same text after the byte order mark, UTF-16, line endings, case, invisible characters and whitespace are normalized, or a text that shares more than half of the mirror file's lines of 20 or more characters (at least three such lines; lines upstream's own version of that path also has do not count). This catches a changed letter, a prepended line or a CRLF conversion. It does not catch a copy that is gzip-compressed, base64-encoded, UTF-32 encoded or otherwise re-encoded, nor a rewrite that shares few lines. Mirror files over 1 MiB are only matched by exact content.
   - adds or changes a file whose content contains origin's URL, origin's `owner/name`, origin's repo name after a host (`github.com/<owner>/<name>`, `git@<host>:<owner>/<name>`, `ssh://` or `https://` URLs; a bare `<owner>/<name>` with another owner, such as a package path, passes in file content), or that is a JSON object shaped like a venfork config (a URL-valued `upstreamUrl` plus a URL-valued `publicForkUrl`, `"mode": "no-public"`, or any of the keys `preserve`, `schedule`, `shippedBranches`, `pulledPrs`, `shippedIssues` and `pulledIssues`; with `VENFORK_ALLOW_SELF_REFERENCE=1`, only when its `upstreamUrl` or `publicForkUrl` names this mirror's upstream or public fork, or one of those link maps is not empty), or whose file name contains one of those terms. Text is read as UTF-8, or as UTF-16 when it starts with a byte order mark, and searched for every term. Every file, text or binary, is also searched byte by byte for origin's URL and `owner/name` encoded as UTF-8, UTF-16LE and UTF-16BE (ignoring ASCII case), whatever byte order mark or NUL bytes it has. Compressed content (gzip, zip and other archives) and UTF-32 text are not decoded, so a mirror reference inside them is not found. A file over 100 MB cannot be checked and is refused. The bare word `venfork` is allowed in file content, so docs can mention the tool. Marker-shaped text (`venfork:internal`, with any spacing or invisible characters) is refused in file content, author, committer and message, even with `VENFORK_ALLOW_SELF_REFERENCE=1`.
   - was authored or committed by the venfork bot.
   - has an author, committer or message that contains origin's URL, origin's `owner/name`, origin's GitHub Pages address (`<owner>.github.io/<name>`), origin's repo name as a whole word (when it has at least six characters and differs from upstream's; `<name>-public`, `my-<name>` and `<name>.ts` pass, but a plain `<name>` or `<name>#12` does not) or the word `venfork`. Text is percent-decoded before matching, so `acme%2Fwidget-private` is found. For an origin on another host, such as GitHub Enterprise, `owner/name` is read from any `host[:/]owner/name` URL. The same terms apply to the branch name and, unless `--no-pr`, to the PR title and body (this includes `<!-- venfork:internal -->` markers).

   Path matching ignores case. A preserve entry that is a directory on origin's default branch, on your local default branch or anywhere in the mirror history the check reads (possible in an old config) is refused as an invalid entry, with the `venfork keep remove '<entry>'` command to run. The branch name goes through the same term check before anything is fetched.
4. Shows the target, the branch, every commit subject and every file that any published commit adds or changes, then asks for confirmation. A file that a later commit deletes is listed as "removed later in the branch, still in history", because the public history still holds it. When commit messages, or (unless `--no-pr`) the upstream PR title or body, contain `#N`, it warns that those numbers will resolve against upstream.
5. Pushes the rebuilt head with `--force-with-lease` and `--no-follow-tags`, so no local tag goes with it.
6. Provides a compare URL so you can open the PR yourself.

Commit messages, author names and author emails are published as they are. Keep them free of anything that points at the private mirror; when stage refuses a commit, rewrite the branch (for example with `git rebase -i`) and stage again. A `#42` reference in a commit message is your own content and is published unchanged; the preview warns about it.

To use venfork on a project whose upstream legitimately mentions venfork, set `VENFORK_ALLOW_SELF_REFERENCE=1`. It relaxes only the bare word `venfork`. URL, owner and repo name terms still apply, and text shaped like a marker (`venfork:internal` in any wrapper, such as `[venfork:internal]`) is still refused in PR titles and bodies. An HTML comment that only mentions the tool (`<!-- uses venfork -->`) passes, but one that reads like a broken marker (`<!-- venfork:intenral -->`, `<!-- venfork internal -->`) is refused.

**What the PR step adds:**
1. Looks up the most recent PR on the private mirror with `--head <branch>` (open first, then most recent of any state). When the approval gate passed, it uses the approved mirror PR instead.
2. Renders the upstream PR body by stripping any `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks. With no internal PR, the body lists the published commit subjects with standalone `#N` references and `(#N)` groups removed (`#N` inside a word or URL is kept). The title and body are then refused if they still contain `venfork`, origin's URL or origin's `owner/name`. The private mirror stays invisible to upstream: no back-link to the internal review and no hint that one exists. The internal PR URL is recorded only in your mirror config (step 5).
3. Shows you the translated body **before** confirming, so you can catch redaction mistakes before they go public.
4. Runs `gh pr create --repo <upstream> --base <default> --head <fork-owner>:<branch>` and surfaces the resulting PR URL.
5. Records the linkage in `venfork-config.shippedBranches[<branch>]` for later tracking.

**Redacting internal-only context**

In the body of your internal review PR, wrap anything that should NOT go upstream in HTML comments:

```md
This PR adds OAuth login.

<!-- venfork:internal -->
Internal note: Client X explicitly asked us to use Auth0 instead of Keycloak (see ticket INT-1234).
<!-- /venfork:internal -->

The implementation follows the spec at https://example.com/oauth.
```

`venfork stage` strips all content enclosed by these markers before posting upstream. The upstream PR shows only the public summary; the internal context stays inside the redacted block on the private mirror, where only your team can see it.

A comment that mentions venfork but is not a well-formed marker (for example a typo such as `venfork:intenral`), an unmatched close marker, or any `venfork` left in the text after stripping stops the stage before anything is pushed. An unmatched open marker drops everything after it. If you forget to add markers around other internal context, it is sent upstream, so review the preview prompt before confirming.

### `venfork stage approval [on|reviewed|two-person|off] [--yes] [--no-input] [--json]`

Show or set how much review a branch needs before `venfork stage` publishes it. The level is stored as `approval` in the mirror's venfork settings, so every clone of the mirror reads the same level. With no argument it prints the current level. `venfork stage branch approval` stages a branch named `approval`.

- `off` - No review needed. This is the default.
- `reviewed` - The branch's PR on the private mirror needs an approving review on its current head from a person (not a bot) with write access to the mirror who is not the PR author, and every check on that head must pass.
- `two-person` - As `reviewed`, and the approver must also be someone other than the GitHub user who runs `venfork stage`.
- `on` - The same as `two-person`.

Setting `off` prints a warning. With `--json`, `result` is `{ "level" }` after the action.

When the level is not `off`, `venfork stage <branch>` (with or without `--no-pr`) checks the mirror PR after it fetches and before it rebuilds anything:

1. It finds the open PR on the mirror whose head is `<branch>` on the mirror and whose base is the mirror default branch. A PR into another branch is refused (`wrong-base`), because the review would not cover the commits of that base branch. When more than one open PR for `<branch>` targets the default branch, stage refuses (`ambiguous-pr`); pass `--internal-pr <n>` to name the PR. `--internal-pr <n>` must name an open PR from `<branch>` on the mirror into the default branch. No open PR is refused.
2. For each reviewer it takes the latest review that approved, requested changes or was dismissed. Comment-only reviews change nothing. A dismissed latest review neither approves nor blocks. A reviewer whose latest review requests changes blocks the stage.
3. At least one approval must count: it is on the PR head commit, from a GitHub user account (not a bot, organization or deleted account) that is not the PR author and has write or admin access to the mirror. With `two-person`, the approver must also differ from the gh login running stage. Only `two-person` reads that login, so `reviewed` works with a token that cannot read `/user`, such as a GitHub App token.
4. Every check run and commit status on the PR head must be complete and passing (`success`, `neutral` or `skipped`). A pending check blocks; run stage again when it finishes.
5. The local branch must point at the approved PR head. Stage then publishes exactly that commit, so new commits after the approval are refused until they are pushed and approved.

The upstream PR body comes from the approved mirror PR.

The gate covers `venfork stage <branch>` only. `venfork stage issue` is not gated, because it publishes redacted issue text, not code.

A refusal exits 1 with code `approval` and a hint. The two refusals a solo vendor meets first, "two-person approval needs a reviewer other than you" and "has no open PR", name `venfork stage approval reviewed`. `--dry-run` runs the same checks, reports a refusal as a warning and in `result.approval`, and still shows the preview. A level from a newer venfork is refused (`config`) instead of being read as `off`.

**A lowered level.** Each clone remembers the last approval level it saw, in a file in the clone's own repository data (`venfork/approval.json` in the git common dir). Git never pushes it. Stage compares the mirror's level with that memory (by rank: `off` < `reviewed` < `two-person`), because an agent with write access to the mirror could lower the level and then stage. When the level is lower, stage asks a person at a terminal "The approval gate was lowered. Stage ...?". `--yes` does not answer this confirm. When venfork cannot prompt (with `--json`, `--no-input` or no terminal), the stage stops with `approval`, reason `gate-weakened`, and names the change. `--dry-run` reports it as `result.weakened` and does not ask. After a person confirms, the clone remembers the new level. When the level is equal or higher, stage records it and does not ask. So a level that was lowered and raised back before the stage is not flagged. When the memory file exists but venfork cannot read it, venfork treats it as `two-person` and says so.

The memory is a convenience, not protection. A fresh clone has no memory, so it does not know an earlier level: its first stage records the level it finds and does not ask. Venfork does not read the venfork-config history for a lowered level. To protect the level, add a branch protection rule or ruleset on the `venfork-config` branch that limits who can push it. The scheduled sync workflow and `sync --report-issues` only read that branch; the commands that write it are `setup`, `stage` (the PR step records the link), `stage issue`, `pull pr`, `pull issue`, `keep`, `schedule`, `workflows` and `stage approval`, so the ruleset must allow the people who run them.

**Bypassing the gate.** `venfork stage <branch> --force` runs the same checks. If the gate says no, stage asks a person at a terminal to confirm the bypass (`--yes` does not answer it; without a terminal stage stops with reason `bypass-unconfirmed`). Just before the push it posts a comment on the mirror PR that names the gh login, the level, the commit staged and why the gate refused. When the comment cannot be posted, nothing is pushed. A branch with no open mirror PR cannot be forced, because the bypass has no PR to be recorded on. A local branch that is not at the mirror PR head cannot be forced either (reason `branch-moved`), because the comment must name a commit on that PR. When stage cannot find the mirror to post on, nothing is pushed. With the level `off`, `--force` changes nothing and says so. The comment is the record; stage writes nothing about the bypass to venfork-config, which anyone with write access to the mirror can push.

Nothing about the gate leaves the mirror: no reviewer name, approval, bypass or process note goes into the published commits, the public fork or the upstream PR. GitHub's review records on the mirror PR are the approval log.

The gate is a guardrail against publishing by accident or by an agent, not enforcement. Anyone with push access to the public fork or upstream can publish without venfork, and anyone with write access to the mirror can change the setting.

```bash
venfork stage approval            # print the level
venfork stage approval on         # two-person
venfork stage approval reviewed   # a solo vendor reviewing an agent's PR
```

### `venfork pull pr <pr-number-or-url> [--branch-name <override>] [--no-push] [--yes] [--no-input] [--json]`

Pull a third-party upstream PR into the private mirror so your team can review it internally before it lands. The PR's commits land on a new branch (`upstream-pr/<n>` by default) that's pushed to your mirror. With `--json`, it prints one JSON envelope on stdout (see [JSON output](json.md#json-output)).

**Arguments:**
- `pr-number-or-url` - Either a bare integer (`1234`) or a github.com PR URL.

**Flags:**
- `--branch-name <name>` - Use a custom local/mirror branch name instead of `upstream-pr/<n>`. To refresh it later, pass the same `--branch-name` again: the re-run finds the branch by its `pulledPrs[<branch>]` record. The name must not be an existing branch that is not a pulled copy of this PR, nor the mirror's default branch or `venfork-config`.
- `--no-push` - Fetch into a local branch only; don't push to the mirror.
- `--no-input` - Never prompt. `pull pr` asks nothing, so it changes nothing; it is accepted so a wrapper can pass one fixed flag set. See [Non-interactive use](headless.md#non-interactive-use).

**Examples:**
```bash
# Bring upstream PR #1234 into the mirror
venfork pull pr 1234

# Or via URL
venfork pull pr https://github.com/upstream/repo/pull/1234

# Use a custom branch name (e.g. for staged team review of a critical PR)
venfork pull pr 1234 --branch-name review/oauth-pr
```

**What it does:**
1. Reads the upstream PR's metadata (`gh pr view`) and prints a summary (title, author, state, base, body preview, link).
2. Fetches `pull/<n>/head` from the upstream remote into a local branch.
3. Pushes that branch to `origin` (the private mirror) so the team can see it.
4. Records a `pulledPrs[<branch>]` entry in the mirror's venfork settings, so a re-run knows the branch holds this PR.

**Refreshing a pulled PR**

When the upstream contributor updates their PR, refresh your local + mirror copy with:

```bash
venfork pull pr 1234
```

A re-run refreshes the branch when it already holds the PR: `pulledPrs[<branch>]` records this PR number, or there is no record and the branch is named `upstream-pr/<n>`. It fetches `pull/<n>/head` and the mirror copy, moves the local branch (or creates it, in a fresh clone) and pushes to origin with a lease on the mirror copy it just fetched. A rebased PR is fine. The re-run refuses, and moves nothing, when the local branch or the mirror copy has commits that are not in the PR, such as an unpushed review fix or a teammate's commit: move them to another branch first. Commits that the mirror copy had before the re-run fetched it do not count as local commits, so a clone that a teammate's refresh of a rebased PR left behind refreshes too. A checked-out branch is moved with `git reset --keep`, so unstaged changes the PR does not touch are kept; staged changes are refused, so commit or stash them first. A local or mirror branch of that name that holds anything else (other than exactly the PR head) is refused, with or without `--branch-name`; pass `--branch-name` with a new name to pull the PR beside it.

### `venfork stage issue <number-or-url> [--title <text>] [--yes] [--no-input] [--json]` and `venfork pull issue <number-or-url> [--title <text>] [--yes] [--no-input] [--json]`

Move *issue* context between the private mirror and upstream. The command names follow the direction: `stage` goes outward (mirror to upstream), `pull` comes inward (upstream to mirror). The shape matches `stage <branch>` and `pull pr`, but for issues instead of PRs. With `--json`, both never prompt and print one JSON envelope on stdout (see [JSON output](json.md#json-output)).

- `venfork stage issue <internal-#>` - read an internal triage issue from the mirror, redact `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks (same convention as `stage <branch>`), and open the upstream counterpart via `gh issue create`. The approval gate does not apply: `stage issue` publishes redacted issue text, not code.
- `venfork pull issue <upstream-#>` - read an upstream issue **and its comments**, create a parallel internal issue on the mirror titled `[upstream #N] <original title>` so the team can triage it without leaving the private space. The upstream comment thread is snapshotted into the mirror issue body under an "Upstream comments" section.

A branch named `issue`, `approval` or `branch` cannot use the bare `venfork stage <name>` form. Run `venfork stage branch issue` instead.

**Flags:**
- `--title <text>` - Override the destination issue's title.
- `--yes`, `-y` - Open the issue without the "Open the issue on ...?" confirm.
- `--no-input` - Never prompt. Without `--yes`, the confirm exits 2 and no issue is opened. See [Non-interactive use](headless.md#non-interactive-use).

**Examples:**
```bash
# Found a bug while working internally: refine then file upstream
venfork stage issue 7

# Watching an upstream issue that affects the team's roadmap
venfork pull issue 1234
```

**What gets recorded**

Both commands write a linkage to `venfork-config`:
- `shippedIssues[<internal-#>]` for `stage issue`
- `pulledIssues[<internal-#>]` for `pull issue`

This is **only the linkage** - there is no *live* sync. `pull issue` snapshots the upstream body and comments into the mirror issue at pull time, but later comments and state changes do not propagate. If the upstream issue is closed, the internal one stays open until you close it manually (and vice versa). Treat the records as a "where did this go?" audit log rather than a live mirror.

### `venfork doctor [--yes] [--no-input] [--json]`

Check that a mirror is healthy, then list the links recorded in `venfork-config` (shipped branches, pulled PRs, shipped and pulled issues, with dates). `--json` prints the [JSON envelope](json.md#json-output) with `result: { "checks": [...], "links": {...}, "healthy": true | false }`; `links` is `null` when the config cannot be read. It only reads, apart from fetching the remotes and the `venfork-config` branch.

- `--no-input` - Never prompt. `doctor` asks nothing, so it changes nothing; it is accepted so a wrapper can pass one fixed flag set. See [Non-interactive use](headless.md#non-interactive-use).

| Check | What it verifies |
|---|---|
| `repo` | You are in a git repo and `venfork-config` is readable |
| `remotes` | `origin`/`upstream`(/`public`) exist, match the config, and upstream push is `DISABLE` |
| `mode` | The remotes match the recorded layout: `standard` (with a public fork) or `own-upstream` (`--own-upstream`, stored as `mode: 'no-public'`) |
| `invariant` | `origin/<default>` is an upstream commit plus at most one managed commit. Several managed or preserve-only commits with no real divergence ask you to run `venfork sync` to fold them |
| `divergence` | No user commits on `origin`/`public` that would make sync abort |
| `preserve` | Every keep entry is a valid single-file path and exists on `origin/<default>`. The text report labels this row `keep`; the JSON id stays `preserve` |
| `workflow` | The sync workflow on `origin/<default>` matches what this venfork version would write |
| `transport` | git can reach origin: `git ls-remote --exit-code <origin push URL> HEAD` runs the way venfork's other git calls run (your ssh command with BatchMode for SSH, the gh credential helper for HTTPS), capped at 30 seconds. SSH failure fix: `gh config set git_protocol https` and re-clone, or load an SSH key (or accept GitHub's host key when ssh does not know it). HTTPS failure fix: `gh auth login`. With a schedule set, an HTTPS origin also needs a gh token with the `workflow` scope, because the managed commit changes a workflow file; the fix is `gh auth refresh -s workflow`. Skipped when origin is not on GitHub |
| `token` | When a schedule is enabled, in both modes: `VENFORK_PUSH_TOKEN` is set on the mirror, or with `schedule set --app` both `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` are set, and the public fork has the mirror's owner. In app mode a leftover `VENFORK_PUSH_TOKEN` is a note, not a failure: the check passes and its fix is the `gh secret delete` command. Doctor can only see that the secrets exist: the token itself needs the `workflow` scope (classic) or Workflows: write (fine-grained), and doctor cannot check the App key or installation |
| `last-run` | The last `venfork-sync.yml` run, from any trigger, did not fail |
| `cron-age` | The workflow is enabled, and the last scheduled run is not older than twice the cron interval, with a floor of 1 hour because GitHub delays scheduled runs |

Each failing check prints a fix. The `token`, `last-run` and `cron-age` checks show as skipped when `gh` is not authenticated or origin is not a GitHub repository; `transport` skips only when origin is not on GitHub, and otherwise fails when git cannot reach origin (for example an HTTPS origin while gh is logged out), and the summary counts skipped checks. If `git fetch` fails, the `remotes` row shows the reason and the checks that need fresh refs are skipped. The command exits 1 when any check fails. With `--json` the envelope is still `ok: true` when a check fails, because doctor ran: read the checks, or the exit code.

### `venfork workflows <status|allow|block|unallow|unblock|clear> [workflow-file ...] [--yes] [--no-input] [--json]`

Manage which upstream workflow files should remain active in the private mirror when managed sync commit logic runs. With `--json`, every action prints one JSON envelope on stdout with the policy after the action (see [JSON output](json.md#json-output)).

- `--no-input` - Never prompt. `workflows` asks nothing, so it changes nothing; it is accepted so a wrapper can pass one fixed flag set. See [Non-interactive use](headless.md#non-interactive-use).

**Examples:**
```bash
venfork workflows status
venfork workflows allow ci.yml lint.yml
venfork workflows block deploy.yml e2e.yml
venfork workflows unblock e2e.yml
venfork workflows clear
```

**What it does:**
1. Stores `enabledWorkflows` / `disabledWorkflows` in `.venfork/config.json` on `venfork-config`
2. `allow` adds workflow filenames to the allowlist; `venfork workflows unallow` removes them
3. `block` adds workflow filenames to the blocklist; `unblock` removes them. Blocking one more file never unblocks the files already on the list
4. `clear` removes both lists
5. Precedence: if `enabledWorkflows` is non-empty, it is used and `disabledWorkflows` is ignored
6. Changes apply to the mirror default branch on next `venfork sync` (a non-empty allow or block list is enough to put the managed commit on the mirror, with or without a schedule or a preserve list)

### `venfork keep <list|add|remove|clear> [path ...] [--yes] [--no-input] [--json]`

Keep mirror-only files (for example a caller workflow or an internal doc) on the mirror default branch across `venfork sync`. Sync normally makes `origin/<default>` equal to upstream; preserved files ride in the single venfork-managed commit instead. With `--json`, every action prints one JSON envelope on stdout with the list after the action (see [JSON output](json.md#json-output)); a path named `--json` goes after `--`.

**Examples:**
```bash
venfork keep add .github/workflows/internal-ci.yml docs/INTERNAL.md
venfork keep list
venfork keep remove docs/INTERNAL.md
venfork keep clear
```

**Rules:**
- Each entry is a single file: a regular file, an executable or a symlink. `keep add` checks `origin/<default>` and refuses directories, missing paths and glob patterns (`*`, `?`, `[`); list each file instead. Commit the file to `origin/<default>` first.
- Paths are clean repo-relative paths: no leading `/` or `-`, no `..` or `.` segments, no backslashes or whitespace.
- Commit the file to `origin/<default>` before you sync. On every sync, venfork copies each preserved file from the previous origin tip into the new managed commit. If a preserved file is missing, sync aborts until you commit it or remove the entry.
- Upstream wins. When upstream adds a file at a preserved path, sync uses upstream's version. If upstream later deletes that path, sync keeps the last version the mirror carried (upstream's last version), because it is still on the previous mirror tip. Run `venfork keep remove <path>` to let it go. A preserved file also cannot be restored when upstream adds a file at one of its parent directories; sync aborts and names the path.
- Commits that only touch preserved files do not count as divergence on origin, so sync folds them into the managed commit.
- `venfork keep remove` and `clear` re-stamp `origin/<default>` in the same step when the managed commit still carries a dropped file.
- The sync workflow and anything under `.venfork/` cannot be preserved: venfork owns them. A commit with the managed trailer that also changes any other file counts as your work, so sync stops on it as divergence.
- If the `venfork-config` branch is missing while `origin/<default>` still carries a managed commit, sync refuses. Restore the branch. `venfork setup` never overwrites an existing config branch.

**Directory entries:** an old config can still hold a directory entry. `venfork stage` and `venfork sync` treat an entry that is a directory on origin's default branch as invalid and refuse to run until you run `venfork keep remove '<directory>'` and add each file. Every `venfork keep add` and `venfork keep remove` command venfork prints single-quotes its paths, so a shell passes them through unchanged (`*.md` is not expanded, `$(...)` does not run).

**Invalid entries:** an entry written by an older venfork, or by hand, that is not a valid single-file path (for example `docs/*.md`) makes sync abort and shows up in `venfork keep list` and `venfork doctor`. Remove it with `venfork keep remove <entry>`, using the entry exactly as listed. `remove` works on invalid entries too.

**Flags:**
- `--no-input` - Never prompt. `keep` asks nothing, so it changes nothing; it is accepted so a wrapper can pass one fixed flag set. See [Non-interactive use](headless.md#non-interactive-use).

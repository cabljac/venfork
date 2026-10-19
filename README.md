<p align="center">
  <img src="https://raw.githubusercontent.com/cabljac/venfork/refs/heads/main/assets/logo.svg" alt="Venfork Logo" width="200" />
</p>

# 🔧 Venfork

[![CI](https://github.com/cabljac/venfork/actions/workflows/ci.yml/badge.svg)](https://github.com/cabljac/venfork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Create and manage private mirrors of public GitHub repositories for vendor development workflows.

## What is Venfork?

Venfork helps contractors and vendors who need to work on private forks of public repositories. It creates a **three-repository workflow**:

1. **Private Mirror** (`yourname/project-private` or `org/project-private`) - Where your team works internally
2. **Public Fork** (`yourname/project` or `org/project`) - Staging area for contributions to upstream
3. **Upstream** (`original/project`) - The original repository

> **Note:** Repos can be created under your personal account or under an organization using the `--org` flag.

### Why Three Repositories?

**The Key Insight:**
> "The private mirror is completely disconnected from the public fork, allowing teams to experiment freely before presenting work to the client"

The private mirror is:
- ✅ Completely disconnected from the public fork
- ✅ Safe space to experiment, iterate, and refine work
- ✅ All internal PRs, reviews, and experiments stay private
- ✅ Only visible to your team

When you run `venfork stage`, your work becomes visible on the public fork and ready for PR to upstream.

## Prerequisites

Before using Venfork, ensure you have:

- **Node.js 22+** or **Bun** (for running the CLI)
- **GitHub CLI (`gh`)** installed and authenticated
  ```bash
  # Install gh (macOS)
  brew install gh

  # Authenticate
  gh auth login
  ```
- **Git** installed locally (used after clone for branches, remotes, and pushes)
- **Clone URLs:** Venfork uses **`gh repo clone`** for fetching repositories, so transport (SSH vs HTTPS) follows your GitHub CLI config (`gh config get git_protocol`). Over HTTPS, the git fetches and pushes that venfork runs use your gh login, so you need no other credential. Over SSH you need an SSH key that GitHub accepts. Your own `git push` outside venfork uses your git credentials as usual (run `gh auth setup-git` to let it use gh too). See [Headless and CI use](#headless-and-ci-use).

## Installation

```bash
# Install globally with npm
npm install -g venfork

# Or with Bun
bun install -g venfork

# Or use with npx (no installation needed)
npx venfork setup <repo-url>
```

The npm package bundles its libraries, so it installs no other packages.

## Quick Start

```bash
# 1a. One-time setup (first team member, personal account)
venfork setup git@github.com:awesome/project.git
# or: venfork setup awesome/project

# Or for organization repos
venfork setup git@github.com:awesome/project.git --org my-company

# The same setup command is safe to re-run when the GitHub repos already exist
# (see "Re-running setup" under venfork setup — repairs remotes, config, and syncs).

# 1b. Clone existing setup (other team members)
venfork clone git@github.com:yourname/project-private.git

cd project-private

# 2. Work privately
git checkout -b feature/new-thing
# ... experiment, iterate, refine ...
git push origin feature/new-thing
# Still private! Create internal PR for team review

# 3. Stage for upstream (after internal approval)
venfork stage feature/new-thing
# NOW visible on public fork — and the upstream PR is opened for you,
# carrying your internal review body (with <!-- venfork:internal --> blocks redacted).

# Or just push the branch and open the PR yourself later:
venfork stage feature/new-thing --no-pr
```

```bash
# Reviewing a third-party upstream PR internally
venfork pull pr 1234
# upstream-pr/1234 now exists on the mirror; team can review/test against your internal codebase

# Refresh as the upstream contributor pushes updates
venfork pull pr 1234
```

## Commands

### `venfork setup <upstream> [name] [--org <organization>] [--fork-name <repo>] [--no-public] [--yes] [--no-input] [--json]`

Creates the complete vendor workflow setup (with `--json`, setup never prompts and prints one JSON envelope on stdout; see [JSON output](#json-output)):

**`<upstream>`** may be a full GitHub clone URL (SSH or HTTPS) or **shorthand** `owner/repo` (e.g. `invertase/react-native-firebase`), which is treated like `git@github.com:owner/repo.git`.

**`--fork-name`** sets the **public fork’s repository name** under your chosen owner/org (passed through to `gh repo fork --fork-name`). Use this when **upstream already lives under the same org** you pass to `--org`: GitHub cannot create a second repo with the same name, so the fork must use a different name (e.g. `my-lib-public` while upstream is `my-lib`).

**`--no-public`** skips the public-fork hop entirely. Only `origin` (private mirror) and `upstream` are configured; `venfork stage` later pushes branches **directly to upstream** and opens an intra-upstream PR (unless `--no-pr`). Use this when you **own the upstream** repo (no client to hide work from): it removes a redundant fork-and-stage round-trip. Mutually exclusive with `--fork-name`.

**What it creates:**
- **Private mirror** (`yourname/project-private` or `org/project-private`) - For internal work
- **Public fork** (`yourname/project` or `org/project`, or the name from **`--fork-name`**) - For staging to upstream *(skipped with `--no-public`)*
- **Config branch** (`venfork-config`) - Stores remote URLs (and `mode: 'no-public'` when applicable) for easy team cloning
- **Local clone** with remotes configured:
  - `origin` → private mirror (default push/pull)
  - `public` → public fork (for staging) *(omitted with `--no-public`)*
  - `upstream` → original repo (read-only, push disabled)

**Arguments:**
- `upstream` - GitHub repository URL (SSH or HTTPS), or shorthand `owner/repo`
- `name` - (Optional) Name for private mirror repo (default: `{repo}-private`)
- `--org <organization>` - (Optional) Create repos under organization instead of personal account
- `--fork-name <repo>` - (Optional) Public fork repo name under that org/user (default: same basename as upstream)
- `--no-public` - (Optional) Skip the public-fork hop; stage pushes directly to upstream
- `--yes`, `-y` - (Optional) Answer the personal-account confirm with yes. `--org <your username>` (compared with your gh login ignoring case) also counts as consent: the repos go under your personal account with no confirm. `VENFORK_ORG` set to your username does not: it is ambient, so the confirm still runs (and needs `--yes` without a terminal).
- `--no-input` - (Optional) Never prompt. A missing `name` defaults to `{repo}-private` (the choice is logged on stderr). A missing `upstream`, or a personal account without `--yes`, exits 2. See [Non-interactive use](#non-interactive-use).

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

# Upstream is already my-org/foo — fork under my-org with a different public repo name
venfork setup my-org/foo my-foo-private --org my-org --fork-name foo-public
# Creates: my-org/my-foo-private (private), my-org/foo-public (public fork), upstream = my-org/foo

# Shorthand also works with --org + --fork-name (equivalent to git@github.com:firebase/extensions.git)
venfork setup firebase/extensions firebase-extensions-private --org invertase --fork-name firebase-extensions

# Upstream is already in your org and there is no public-vs-private audience to maintain
# — skip the fork hop entirely. `stage` will push directly to my-org/foo and open an intra-repo PR.
venfork setup my-org/foo my-foo-private --org my-org --no-public
# Creates: my-org/my-foo-private (private), upstream = my-org/foo. No public fork.
```

**Re-running setup (repos already on GitHub):** Run the same command again if you need a fresh local clone, remote fixes, or an updated `venfork-config` branch. Venfork uses `gh repo view` to detect a public fork or private mirror that already exists when `gh repo fork` or `gh repo create` fails, then:

- Skips seeding a **new** private mirror from upstream (no duplicate initial push).
- Clones the private mirror into `./<private-mirror-name>`, or **reuses** that directory if it is already a git repo whose `origin` points at the expected mirror URL.
- Ensures `public` and `upstream` remotes exist and point at the right URLs (adds or corrects them).
- Pushes the `venfork-config` branch again so teammates get current URLs.
- If **either** GitHub repo was already present, runs **`venfork sync` inside that clone** so defaults are normalized from `upstream` (subject to divergence safeguards): `public` matches upstream, while `origin` may include one managed workflow commit when scheduled sync is enabled.

Pure failures (for example name taken by a **different** repo) still abort setup. If recovery sync stops due to divergent default branches, fix or move those commits, then run **`venfork sync`** again from inside the private mirror.

### `venfork clone <vendor-repo> [--no-public] [--upstream <url>] [--public-fork <url>] [--yes] [--no-input] [--json]`

Clone an existing vendor setup and automatically configure all remotes. With `--json`, clone never prompts and prints one JSON envelope on stdout (see [JSON output](#json-output)).

**`<vendor-repo>`** is the private mirror: full GitHub URL or shorthand `owner/repo`.

**What it does:**
- Clones the private mirror repository
- **Reads venfork-config branch** for layout (`mode`) and URLs (if available)
- Falls back to auto-detection when the config branch is absent:
  - Public fork (by stripping `-private` suffix)
  - Upstream repository (from public fork's parent)
- Configures the appropriate remotes (origin/upstream, plus public in standard mode)
- Disables push to upstream (read-only)

**Options** (only meaningful for **legacy mirrors** without a `venfork-config` branch. When config is present it is authoritative: a flag that names the recorded value is accepted, and a flag that contradicts it is an error):
- `--no-public` - Declare a no-public layout (origin + upstream only). Use when the original setup was created with `venfork setup --no-public` but the config branch is missing.
- `--upstream <url>` - Provide the upstream explicitly, as a GitHub URL or `owner/repo` (anything else exits 2). Useful with `--no-public` (no public fork to derive it from) or to skip the auto-detect prompt.
- `--public-fork <url>` - Provide the public fork (GitHub URL or `owner/repo`) explicitly. Skips the public-fork detection and prompt; upstream is still read from the fork's parent unless `--upstream` is given. Cannot be combined with `--no-public`.

`--no-input` never prompts: a URL that clone would ask for exits 2 and names the flag that supplies it. `clone` accepts `--yes` like every command, but has nothing to confirm, so it changes nothing. A clone that fails or is cancelled after the repository was cloned removes the cloned directory, so you can rerun it with the named flag.

**Use this when:**
- A teammate has already run `venfork setup`
- You need to clone an existing vendor setup
- You want automatic remote configuration

**Arguments:**
- `vendor-repo` - GitHub URL or `owner/repo` of the private vendor repository

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
- Without a terminal (see [Non-interactive use](#non-interactive-use)) these prompts exit 2 instead and name the flag: `--public-fork <url>` for the public fork, `--upstream <url>` for upstream. Use `--no-public --upstream <url>` when the mirror has no public fork

### `venfork sync [--report-issues] [--yes] [--no-input] [--json]`

With `--json`, sync prints one JSON envelope on stdout (see [JSON output](#json-output)).

Update default branches from upstream. With scheduled sync or a preserve list enabled, the private mirror uses a managed `+0/+1` model:
- `public/<default>` matches `upstream/<default>`
- `origin/<default>` is `upstream/<default>` plus at most one deterministic managed commit (the sync workflow and preserved files). If that commit would add nothing, `origin/<default>` equals `upstream/<default>`.
- The managed commit's SHA depends only on the upstream tip and its content, so a sync with nothing new to bring in pushes nothing and teammates never see a rewritten default branch.

Normally you run this from your private mirror directory (or any subfolder of that repo). The same behavior is also used internally when **`venfork setup`** completes in recovery mode (existing GitHub repos), using the new clone’s path automatically.

Sync takes no branch: it always syncs upstream's default branch (auto-detected, usually `main` or `master`). `venfork sync <branch>` is a usage error (exit 2); to refresh a pulled upstream PR, run `venfork pull pr <n>` again.

**Flags:**
- `--report-issues` - Open or refresh a `venfork-sync-blocked` issue on the mirror when sync is blocked, and close it after a successful sync. The scheduled workflow passes this flag (see "When a scheduled sync fails" below)

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
- A preserved file that upstream adds is replaced by upstream's version. If upstream later deletes that path again, sync keeps the last version the mirror carried (upstream's last version), because it is still on the previous mirror tip. Run `venfork preserve remove <path>` to let it go

### `venfork stage <branch> [--no-pr] [--draft] [--dry-run] [--title <text>] [--base <branch>] [--internal-pr <n>] [--no-update-existing] [--yes] [--no-input] [--json]`

Push a branch to the public fork, making it visible and ready for PR to upstream. `venfork stage branch <name>` is the explicit form of the same command; use it for a branch named `issue` or `branch`. It also opens the upstream PR for you using your internal review PR's body, unless you pass `--no-pr`. With `--json`, stage never prompts and prints one JSON envelope on stdout (see [JSON output](#json-output)).

**⚠️ Important:** This is when your work becomes visible to the client!

**Arguments:**
- `branch` - Branch name to stage

**Flags:**
- By default stage also opens the upstream PR. It looks up your internal-review PR on the private mirror and copies its description (with redacted blocks stripped).
- `--no-pr` - Push the branch only and print the compare link. `--draft`, `--title`, `--internal-pr` and `--no-update-existing` need the PR, so they are usage errors with `--no-pr`; `--base` still sets the compare link. `--pr` is still accepted for one release and changes nothing.
- `--draft` - Open the upstream PR as a draft.
- `--dry-run` - Run every check, rebuild the branch and build the upstream PR title and body after redaction, print them, and stop. Nothing is pushed, no PR is opened or edited, and nothing is recorded. It needs no `--yes`. With the default PR it still reads the internal review PR through gh, and it looks for an open upstream PR for the branch: when one is open, the preview shows that a real stage keeps its title and replaces only its body (or, with `--no-update-existing`, leaves it unchanged). `--dry-run --no-pr` does not use GitHub beyond the fetch.
- A branch with no commits to publish beyond upstream's default branch is refused (`precondition`, "Nothing to stage"). Merge commits and venfork-managed commits do not count: stage drops them.
- `--title <text>` - Override the upstream PR title (default: the internal PR title, or the branch name if no internal PR was found).
- `--base <branch>` - Override the upstream base branch (default: upstream's default branch).
- `--internal-pr <n>` - Pin a specific internal-review PR number (skips the most-recent-open lookup). Useful when multiple PRs target the same branch.
- `--no-update-existing` - Do not update an already-open upstream PR body when staging. By default, if an upstream PR for the branch already exists, `venfork stage` refreshes its body with the latest translated content.
- `--yes`, `-y` - Answer the "Push to public fork and open the upstream PR?" (no-public: "Push to upstream and open the PR?") confirm with yes. With `--no-pr` the confirm is "Push to public fork?" (or "Push to upstream?"). Required when venfork cannot prompt.
- `--no-input` - Never prompt. Without `--yes`, the confirm exits 2 and nothing is pushed. See [Non-interactive use](#non-interactive-use).

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
1. Refuses branches that are not upstream work: upstream's default branch, anything that is not a local branch (tags, remote-tracking refs), `venfork-config`, and a branch with no history in common with upstream. Like sync, it also refuses while the preserve list holds entries venfork no longer accepts, and names the `venfork preserve remove` command for each.
2. Fetches upstream and origin, then rebuilds the branch as a linear history on `upstream/<default>`: every non-merge commit is cherry-picked in order and venfork-managed commits are dropped. Merge commits never ship (a merge with a manual conflict resolution is refused, since dropping it would lose work). The rebuilt commits get new SHAs even when the branch was already based on upstream.
3. Checks every rebuilt commit before anything is pushed and refuses the branch when a commit:
   - adds or changes `.github/workflows/venfork-sync.yml`, anything under `.venfork/`, or a preserved path (unless the result is exactly upstream's file at that path). Deleting a preserved file is allowed.
   - adds a file whose content is identical to a preserved file on the mirror, at any path (catches renames and copies). The check covers every earlier version of a preserved file that the clone still knows and every earlier version of the venfork config: the mirror refs, their reflog entries and the history of both that upstream does not contain (up to 20000 commits and 20000 reflog entries per ref). A version that upstream itself has published at the same path is not mirror content. When a ref has more than 20000 reflog entries, or that history holds more than 20000 commits, stage refuses, because the older mirror-only history cannot be checked: stage from a clone whose reflog is shorter (a fresh clone has almost none), or, after confirming no mirror-only history older than that is needed, drop old entries with `git reflog expire --expire=<date> --all`. There is no override.
   - adds a text file that is a near copy of a preserved file, the managed workflow or the venfork config: the same text after the byte order mark, UTF-16, line endings, case, invisible characters and whitespace are normalized, or a text that shares more than half of the mirror file's lines of 20 or more characters (at least three such lines; lines upstream's own version of that path also has do not count). This catches a changed letter, a prepended line or a CRLF conversion. It does not catch a copy that is gzip-compressed, base64-encoded, UTF-32 encoded or otherwise re-encoded, nor a rewrite that shares few lines. Mirror files over 1 MiB are only matched by exact content.
   - adds or changes a file whose content contains origin's URL, origin's `owner/name`, origin's repo name after a host (`github.com/<owner>/<name>`, `git@<host>:<owner>/<name>`, `ssh://` or `https://` URLs; a bare `<owner>/<name>` with another owner, such as a package path, passes in file content), or that is a JSON object shaped like a venfork config (a URL-valued `upstreamUrl` plus a URL-valued `publicForkUrl`, `"mode": "no-public"`, or any of the keys `preserve`, `schedule`, `shippedBranches`, `pulledPrs`, `shippedIssues` and `pulledIssues`; with `VENFORK_ALLOW_SELF_REFERENCE=1`, only when its `upstreamUrl` or `publicForkUrl` names this mirror's upstream or public fork, or one of those link maps is not empty), or whose file name contains one of those terms. Text is read as UTF-8, or as UTF-16 when it starts with a byte order mark, and searched for every term. Every file, text or binary, is also searched byte by byte for origin's URL and `owner/name` encoded as UTF-8, UTF-16LE and UTF-16BE (ignoring ASCII case), whatever byte order mark or NUL bytes it has. Compressed content (gzip, zip and other archives) and UTF-32 text are not decoded, so a mirror reference inside them is not found. A file over 100 MB cannot be checked and is refused. The bare word `venfork` is allowed in file content, so docs can mention the tool. Marker-shaped text (`venfork:internal`, with any spacing or invisible characters) is refused in file content, author, committer and message, even with `VENFORK_ALLOW_SELF_REFERENCE=1`.
   - was authored or committed by the venfork bot.
   - has an author, committer or message that contains origin's URL, origin's `owner/name`, origin's GitHub Pages address (`<owner>.github.io/<name>`), origin's repo name as a whole word (when it has at least six characters and differs from upstream's; `<name>-public`, `my-<name>` and `<name>.ts` pass, but a plain `<name>` or `<name>#12` does not) or the word `venfork`. Text is percent-decoded before matching, so `acme%2Fwidget-private` is found. For an origin on another host, such as GitHub Enterprise, `owner/name` is read from any `host[:/]owner/name` URL. The same terms apply to the branch name and, unless `--no-pr`, to the PR title and body (this includes `<!-- venfork:internal -->` markers).

   Path matching ignores case. A preserve entry that is a directory on origin's default branch, on your local default branch or anywhere in the mirror history the check reads (possible in an old config) is refused as an invalid entry, with the `venfork preserve remove '<entry>'` command to run. The branch name goes through the same term check before anything is fetched.
4. Shows the target, the branch, every commit subject and every file that any published commit adds or changes, then asks for confirmation. A file that a later commit deletes is listed as "removed later in the branch, still in history", because the public history still holds it. When commit messages, or (unless `--no-pr`) the upstream PR title or body, contain `#N`, it warns that those numbers will resolve against upstream.
5. Pushes the rebuilt head with `--force-with-lease` and `--no-follow-tags`, so no local tag goes with it.
6. Provides a compare URL so you can open the PR yourself.

Commit messages, author names and author emails are published as they are. Keep them free of anything that points at the private mirror; when stage refuses a commit, rewrite the branch (for example with `git rebase -i`) and stage again. A `#42` reference in a commit message is your own content and is published unchanged; the preview warns about it.

To use venfork on a project whose upstream legitimately mentions venfork, set `VENFORK_ALLOW_SELF_REFERENCE=1`. It relaxes only the bare word `venfork`. URL, owner and repo name terms still apply, and text shaped like a marker (`venfork:internal` in any wrapper, such as `[venfork:internal]`) is still refused in PR titles and bodies. An HTML comment that only mentions the tool (`<!-- uses venfork -->`) passes, but one that reads like a broken marker (`<!-- venfork:intenral -->`, `<!-- venfork internal -->`) is refused.

**What the PR step adds:**
1. Looks up the most recent PR on the private mirror with `--head <branch>` (open first, then most recent of any state).
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

### `venfork pull pr <pr-number-or-url> [--branch-name <override>] [--no-push] [--yes] [--no-input] [--json]`

Pull a third-party upstream PR into the private mirror so your team can review it internally before it lands. The PR's commits land on a new branch (`upstream-pr/<n>` by default) that's pushed to your mirror. With `--json`, it prints one JSON envelope on stdout (see [JSON output](#json-output)).

**Arguments:**
- `pr-number-or-url` - Either a bare integer (`1234`) or a github.com PR URL.

**Flags:**
- `--branch-name <name>` - Use a custom local/mirror branch name instead of `upstream-pr/<n>`. To refresh it later, pass the same `--branch-name` again: the re-run finds the branch by its `pulledPrs[<branch>]` record. The name must not be an existing branch that is not a pulled copy of this PR, nor the mirror's default branch or `venfork-config`.
- `--no-push` - Fetch into a local branch only; don't push to the mirror.

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

Move *issue* context between the private mirror and upstream. The command names follow the direction: `stage` goes outward (mirror to upstream), `pull` comes inward (upstream to mirror). The shape matches `stage <branch>` and `pull pr`, but for issues instead of PRs. With `--json`, both never prompt and print one JSON envelope on stdout (see [JSON output](#json-output)).

- `stage issue <internal-#>` - read an internal triage issue from the mirror, redact `<!-- venfork:internal -->...<!-- /venfork:internal -->` blocks (same convention as `stage <branch>`), and open the upstream counterpart via `gh issue create`.
- `pull issue <upstream-#>` - read an upstream issue **and its comments**, create a parallel internal issue on the mirror titled `[upstream #N] <original title>` so the team can triage it without leaving the private space. The upstream comment thread is snapshotted into the mirror issue body under an "Upstream comments" section.

A branch named `issue` or `branch` cannot use the bare `venfork stage <name>` form. Run `venfork stage branch issue` instead.

**Flags:**
- `--title <text>` - Override the destination issue's title.
- `--yes`, `-y` - Open the issue without the "Open the issue on ...?" confirm.
- `--no-input` - Never prompt. Without `--yes`, the confirm exits 2 and no issue is opened. See [Non-interactive use](#non-interactive-use).

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

This is **only the linkage** — there is no *live* sync. `pull issue` snapshots the upstream body and comments into the mirror issue at pull time, but later comments and state changes do not propagate. If the upstream issue is closed, the internal one stays open until you close it manually (and vice versa). Treat the records as a "where did this go?" audit log rather than a live mirror.

### `venfork doctor [--yes] [--no-input] [--json]`

Check that a mirror is healthy, then list the links recorded in `venfork-config` (shipped branches, pulled PRs, shipped and pulled issues, with dates). `--json` prints the [JSON envelope](#json-output) with `result: { "checks": [...], "links": {...}, "healthy": true | false }`; `links` is `null` when the config cannot be read. It only reads, apart from fetching the remotes and the `venfork-config` branch.

| Check | What it verifies |
|---|---|
| `repo` | You are in a git repo and `venfork-config` is readable |
| `remotes` | `origin`/`upstream`(/`public`) exist, match the config, and upstream push is `DISABLE` |
| `mode` | The remotes match the recorded `standard` / `no-public` mode |
| `invariant` | `origin/<default>` is an upstream commit plus at most one managed commit. Several managed or preserve-only commits with no real divergence ask you to run `venfork sync` to fold them |
| `divergence` | No user commits on `origin`/`public` that would make sync abort |
| `preserve` | Every preserve entry is a valid single-file path and exists on `origin/<default>` |
| `workflow` | The sync workflow on `origin/<default>` matches what this venfork version would write |
| `transport` | git can reach origin: `git ls-remote --exit-code <origin push URL> HEAD` runs the way venfork's other git calls run (your ssh command with BatchMode for SSH, the gh credential helper for HTTPS), capped at 30 seconds. SSH failure fix: `gh config set git_protocol https` and re-clone, or load an SSH key (or accept GitHub's host key when ssh does not know it). HTTPS failure fix: `gh auth login`. With a schedule set, an HTTPS origin also needs a gh token with the `workflow` scope, because the managed commit changes a workflow file; the fix is `gh auth refresh -s workflow`. Skipped when origin is not on GitHub |
| `token` | When a schedule is enabled, in both modes: `VENFORK_PUSH_TOKEN` is set on the mirror, or with `schedule set --app` both `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` are set, and the public fork has the mirror's owner. In app mode a leftover `VENFORK_PUSH_TOKEN` is a note, not a failure: the check passes and its fix is the `gh secret delete` command. Doctor can only see that the secrets exist: the token itself needs the `workflow` scope (classic) or Workflows: write (fine-grained), and doctor cannot check the App key or installation |
| `last-run` | The last `venfork-sync.yml` run, from any trigger, did not fail |
| `cron-age` | The workflow is enabled, and the last scheduled run is not older than twice the cron interval, with a floor of 1 hour because GitHub delays scheduled runs |

Each failing check prints a fix. The `token`, `last-run` and `cron-age` checks show as skipped when `gh` is not authenticated or origin is not a GitHub repository; `transport` skips only when origin is not on GitHub, and otherwise fails when git cannot reach origin (for example an HTTPS origin while gh is logged out), and the summary counts skipped checks. If `git fetch` fails, the `remotes` row shows the reason and the checks that need fresh refs are skipped. The command exits 1 when any check fails. With `--json` the envelope is still `ok: true` when a check fails, because doctor ran: read the checks, or the exit code.

### `venfork schedule <status|set <cron> [--app|--token]|disable> [--yes] [--no-input] [--json]`

Manage automated sync configuration stored in `venfork-config`. With `--json`, every action prints one JSON envelope on stdout with the schedule after the action (see [JSON output](#json-output)).

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

The workflow runs `venfork sync --report-issues` with the job's `GITHUB_TOKEN` (the workflow asks for `issues: write`). If sync is blocked by divergent commits, it opens an issue on the mirror labelled `venfork-sync-blocked`, or refreshes the body of the open one, with the changed files and the exact `venfork preserve add ...` or rebase steps. A final `if: failure()` step covers every other failure (install errors, a missing token, timeouts) by opening the same labelled issue or commenting on it with the run URL. The next successful sync comments "Resolved by <run>" and closes the issue. If you close the issue by hand while the divergence is still there, the next blocked run opens a new one. Outside GitHub Actions, `--report-issues` only files the issue when gh confirms the mirror is a private repository.

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

**Upgrading from 0.10 or earlier**

Scheduled mirrors created by 0.10 or earlier run an unpinned `npm install -g venfork`. Once 0.11 is on npm, a scheduled run installs it, sees the unpinned workflow and stops with the migration message. It does not rewrite the managed commit. Every scheduled run fails the same way until you migrate the mirror locally:

1. Install venfork 0.11 or later locally: the released version from npm, or the release tarball.
2. Create `VENFORK_PUSH_TOKEN` on the mirror (see "Authenticating cross-repo pushes" above). The new workflow needs it in both modes.
3. In a clone of the mirror, run `venfork sync` once. The pinned workflow lands on the default branch, so later runs install exactly that version.

The next scheduled run then succeeds and closes the `venfork-sync-blocked` issue. `venfork doctor` reports an unmigrated mirror on its `workflow` check.

### How scheduled sync behaves

- **Cron is best-effort.** GitHub runs scheduled workflows only from the default branch, at most every 5 minutes, and may delay or skip runs when Actions is busy. Do not rely on exact timing. `venfork doctor` flags a disabled workflow, and a last scheduled run older than twice the cron interval (at least 1 hour).
- **Idle repositories.** GitHub disables scheduled workflows in a public repository after 60 days without activity. A private mirror is not affected by that rule, but if you make a mirror public, re-enable the workflow from the Actions tab when it stops.
- **The workflow file must stay on the default branch.** It lives in the venfork-managed commit. Sync builds the new tip first and moves the default branch in a single leased push, so the file is never missing between runs.
- **Token.** Both modes need a push credential, because the job token cannot push upstream workflow changes, nor push to the public fork. By default that is the `VENFORK_PUSH_TOKEN` secret, a fine-grained token with Workflows: write limited to the mirror and the public fork. With `--app` it is a one-hour token minted from the `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` secrets (see above). A run without its secrets fails at its first step and opens the `venfork-sync-blocked` issue. `venfork doctor` also checks that the secrets exist.
- **Failures open an issue.** Blocked or failed runs open or update a `venfork-sync-blocked` issue on the mirror; the next successful run closes it.
- **Upgrades.** The workflow pins the venfork version that wrote it. Install a newer venfork locally and run `venfork sync` to move the mirror to it.
- **Right after a release.** A release tag can exist for a few minutes before `npm publish` finishes. A local sync in that window can pin a version that npm does not have yet. The scheduled run then fails at "Install venfork" and opens the `venfork-sync-blocked` issue. The next run after the publish succeeds and closes it. To bridge the gap, set `VENFORK_INSTALL_SPEC` (see above).

### `venfork workflows <status|allow|block|unallow|unblock|clear> [workflow-file ...] [--yes] [--no-input] [--json]`

Manage which upstream workflow files should remain active in the private mirror when managed sync commit logic runs. With `--json`, every action prints one JSON envelope on stdout with the policy after the action (see [JSON output](#json-output)).

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
2. `allow` adds workflow filenames to the allowlist; `unallow` removes them
3. `block` adds workflow filenames to the blocklist; `unblock` removes them. Blocking one more file never unblocks the files already on the list
4. `clear` removes both lists
5. Precedence: if `enabledWorkflows` is non-empty, it is used and `disabledWorkflows` is ignored
6. Changes apply to the mirror default branch on next `venfork sync` (a non-empty allow or block list is enough to put the managed commit on the mirror, with or without a schedule or a preserve list)

### `venfork preserve <list|add|remove|clear> [path ...] [--yes] [--no-input] [--json]`

Keep mirror-only files (for example a caller workflow or an internal doc) on the mirror default branch across `venfork sync`. Sync normally makes `origin/<default>` equal to upstream; preserved files ride in the single venfork-managed commit instead. With `--json`, every action prints one JSON envelope on stdout with the list after the action (see [JSON output](#json-output)); a path named `--json` goes after `--`.

**Examples:**
```bash
venfork preserve add .github/workflows/internal-ci.yml docs/INTERNAL.md
venfork preserve list
venfork preserve remove docs/INTERNAL.md
venfork preserve clear
```

**Rules:**
- Each entry is a single file: a regular file, an executable or a symlink. `preserve add` checks `origin/<default>` and refuses directories, missing paths and glob patterns (`*`, `?`, `[`); list each file instead. Commit the file to `origin/<default>` first.
- Paths are clean repo-relative paths: no leading `/` or `-`, no `..` or `.` segments, no backslashes or whitespace.
- Commit the file to `origin/<default>` before you sync. On every sync, venfork copies each preserved file from the previous origin tip into the new managed commit. If a preserved file is missing, sync aborts until you commit it or remove the entry.
- Upstream wins. When upstream adds a file at a preserved path, sync uses upstream's version. If upstream later deletes that path, sync keeps the last version the mirror carried (upstream's last version), because it is still on the previous mirror tip. Run `venfork preserve remove <path>` to let it go. A preserved file also cannot be restored when upstream adds a file at one of its parent directories; sync aborts and names the path.
- Commits that only touch preserved files do not count as divergence on origin, so sync folds them into the managed commit.
- `venfork preserve remove` and `clear` re-stamp `origin/<default>` in the same step when the managed commit still carries a dropped file.
- The sync workflow and anything under `.venfork/` cannot be preserved: venfork owns them. A commit with the managed trailer that also changes any other file counts as your work, so sync stops on it as divergence.
- If the `venfork-config` branch is missing while `origin/<default>` still carries a managed commit, sync refuses. Restore the branch. `venfork setup` never overwrites an existing config branch.

**Directory entries:** an old config can still hold a directory entry. `venfork stage` and `venfork sync` treat an entry that is a directory on origin's default branch as invalid and refuse to run until you run `venfork preserve remove '<directory>'` and add each file. Every `venfork preserve add` and `venfork preserve remove` command venfork prints single-quotes its paths, so a shell passes them through unchanged (`*.md` is not expanded, `$(...)` does not run).

**Invalid entries:** an entry written by an older venfork, or by hand, that is not a valid single-file path (for example `docs/*.md`) makes sync abort and shows up in `venfork preserve list` and `venfork doctor`. Remove it with `venfork preserve remove <entry>`, using the entry exactly as listed. `remove` works on invalid entries too.

## Output Streams

venfork keeps stdout for results and sends everything a human reads to stderr:

- **stdout** carries only results: `venfork --version`, help you ask for (`venfork help`, `venfork <command> --help`) and the `--json` envelope.
- **stderr** carries progress, spinners, prompts, warnings, errors, usage printed for a bad command line (including bare `venfork` with no command), the human-readable reports of `doctor`, `schedule status`, `workflows status` and `preserve list`, and the output of git and gh subprocesses.

So `venfork doctor --json > health.json` writes clean JSON while progress still shows in the terminal, and `venfork sync 2>sync.log` keeps stdout empty.

When stderr is a terminal, venfork draws styled output with colors and spinners. When stderr is not a terminal (a pipe, a file, CI), `NO_COLOR` is set to a non-empty value, or `TERM` is `dumb`, it prints plain lines with no ANSI escape codes and no spinner animation. Each line starts with a level prefix: `info:`, `ok:`, `step:`, `warn:`, `error:`. A spinner prints one `step:` line when it starts and one `done:` (or `error:`) line when it stops.

## JSON output

Every command accepts `--json`: `setup`, `clone`, `sync`, `schedule`, `stage` (branch and `stage issue`), `pull pr`, `pull issue`, `doctor`, `workflows` and `preserve`, with every action of `schedule`, `workflows` and `preserve`. With it, stdout gets exactly one JSON object on one line, followed by a newline, also when the command fails. Progress, warnings and errors still go to stderr as usual. The exit code still follows the [exit codes](#non-interactive-use) table.

`--json` implies `--no-input`: venfork never prompts, even at a terminal. A confirm without `--yes` gives a `missing-input` error and exit 2, and so does a value that only a prompt could give (for example `setup` without `<upstream>`, or `clone` of a legacy mirror without `--public-fork`).

```json
{ "schemaVersion": 1, "ok": true, "result": { } }
{ "schemaVersion": 1, "ok": false, "error": { "code": "missing-input", "message": "...", "flag": "--yes" } }
{ "schemaVersion": 1, "ok": false, "error": { "code": "branch-not-found", "message": "...", "hint": "Run `git branch` to list local branches.", "details": { "branch": "feat" } } }
```

An error can carry `hint`, the next step (often a command to run), and `details`, facts a script can act on. Without `--json`, the hint prints after the message on the same line. `details` per code: `branch-not-found` `{ branch }`; `sync-divergence` `{ branch, origin: { count, files }, public: { count, files }, command? }`, where `command` is the `venfork preserve add <files>` that keeps origin's files, each path single-quoted, present only when 1 to 10 of the files can be preserved (`origin.files` always lists every file); `precondition` for a preserved file sync cannot restore `{ path, command }`, where `command` is the `venfork preserve remove` for it; `stage-leak` `{ branch, paths, leak: "path" | "content", commit? }`; `mirror-reference` `{ where, matched }`; `redaction` `{ snippet }`; `remote-not-found` `{ remote }`; `config` `{ reason }`; `pin-downgrade` `{ pinned, running }`; `missing-input` `{ flag, question }`.

`schemaVersion` changes only when a field is removed or changes meaning. New fields can be added in the same version.

Any command line that contains `--json` before any `--` gets the envelope, whatever the command: a usage error, an unknown or renamed command or `--json` before the command (`venfork --json sync`) prints the error envelope with code `usage` and exit 2. Help and `--version` print text, so `--json` with `help`, `-h`, `--help` or `--version` is also a usage error. A SIGINT prints the `cancelled` envelope and exits 130; a SIGTERM prints it and exits 143.

**Error codes** (`error.code`):

| Code | Meaning |
| --- | --- |
| `usage` | Bad command line (exit 2) |
| `missing-input` | venfork could not prompt and no flag gave the answer; `error.flag` names the flag (exit 2) |
| `cancelled` | Cancelled or interrupted (exit 130, or 143 for SIGTERM) |
| `auth` | gh is not authenticated, or not installed (the message says which) |
| `git` | A git operation failed, for example a rejected push |
| `github` | A gh call to GitHub failed, for example creating a fork or repo, reading an issue or opening a PR; the message is gh's error |
| `precondition` | The state on GitHub, on disk or in `venfork-config` does not allow the action, for example an existing directory, a repo that is not the expected fork, a flag that contradicts the recorded layout, a path that is not in the preserve list, or staging upstream's default branch |
| `remote-not-found` | A required remote (`origin`, `public`, `upstream`) is missing |
| `not-in-repository` | A command that runs in a mirror (`sync`, `stage`, `pull`, `schedule`, `workflows`, `preserve`) was run outside a git repository |
| `branch-not-found` | The branch does not exist |
| `sync-divergence` | Sync stopped: origin or public has commits upstream does not have |
| `config` | The `venfork-config` branch is missing, cannot be read, is invalid, or moved during a write |
| `redaction` | A title or body mentions venfork outside a well-formed internal block |
| `mirror-reference` | Text bound for upstream points back at the private mirror |
| `stage-leak` | Stage would publish a mirror-only path or its content, or it cannot check the mirror history (too many reflog entries or commits, a directory where venfork writes a file, a file over 100 MB). Text that names the mirror is `mirror-reference`, and a bad internal block is `redaction` |
| `pin-downgrade` | origin pins a newer venfork than the one running |
| `unmigrated-mirror` | The mirror's sync workflow predates venfork 0.11 |
| `runtime` | Another venfork runtime failure |
| `internal` | An unexpected error that venfork did not classify |

**Results** (`result`), per command:

- `sync` on the default branch: `{ "kind": "default-branch", "status": "pushed" | "up-to-date", "branch", "upstreamTip", "origin": { "tip", "pushed" }, "public"?: { "tip", "pushed" } }`. `public` is absent in no-public mode. `status` is `pushed` when origin or public moved.
- `pull pr`: `{ "branch", "head", "prNumber", "prUrl", "pushed", "refreshed" }`. `refreshed` is true when this PR's copy already existed (the local branch, the mirror copy or a matching `pulledPrs` record), also when its head did not move. `pushed` is false with `--no-push` or a failed push; a failed push exits 1, with or without `--json`.
- `stage <branch>`: `{ "branch", "head", "target": "public" | "upstream", "compareUrl", "prAction"?, "prUrl"?, "internalPrUrl"? }`. `head` is the rebuilt commit that was pushed. `prAction` is present unless `--no-pr`: `created`, `updated` (an open PR's body was refreshed), `unchanged` (an open PR was left as is) or `failed` (the push worked, the PR could not be opened or its body could not be updated; the run exits 1).
- `stage <branch> --dry-run`: `{ "dryRun": true, "branch", "head", "target", "compareUrl", "base", "commits", "files", "removedLater", "prTitle"?, "prBody"?, "existingPrUrl"?, "internalPrUrl"? }`. Nothing was pushed: `head` is the preview rebuild's local commit (a real stage rebuilds again, so its SHA differs but its tree is the same), `commits` are its subjects oldest first, and `prTitle`/`prBody` are the redacted PR text that a real stage would publish (absent with `--no-pr`). `existingPrUrl` is the open upstream PR a real stage would update; with it, `prTitle` is absent (the title stays), and with `--no-update-existing` `prBody` is absent too.
- `stage issue` and `pull issue`: `{ "number", "url", "source": { "number", "url" } }`. `number` and `url` are the issue venfork opened; `source` is the issue it was made from.
- `doctor`: `{ "checks": [{ "id", "ok": true | false | "skipped", "detail", "fix"? }], "links": { "shippedBranches", "pulledPrs", "shippedIssues", "pulledIssues" } | null, "healthy" }`. `healthy` is false when any check failed. Doctor that ran is `ok: true` even when a check failed; it then exits 1.
- `setup`: `{ "mode": "standard" | "no-public", "mirror": { "repo", "url" }, "publicFork"?: { "repo", "url" }, "upstream": { "repo", "url" }, "directory" }`. `repo` is `owner/name` and `url` its `https://github.com/` page. `publicFork` is absent in no-public mode. `directory` is the absolute path of the local mirror checkout.
- `clone`: `{ "mode": "standard" | "no-public", "directory", "remotes": { "origin", "public"?, "upstream" } }`. `remotes` holds each remote's fetch URL; `public` is absent in no-public mode.
- `schedule` (every action): `{ "enabled", "cron"?, "auth": "token" | "app" }`, the schedule after the action. `cron` is absent when none is stored; `disable` keeps the stored cron.
- `workflows` (every action): `{ "mode": "allow" | "block" | "none", "enabledWorkflows", "disabledWorkflows" }`, the policy after the action. `mode` is `allow` when the allowlist is set (it wins over the block list), `block` when only the block list is set.
- `preserve` (every action): `{ "paths", "invalidPaths" }`, the list after the action. `invalidPaths` are entries sync refuses to run with until they are removed.

```bash
venfork sync --json | jq -r '.result.status'
venfork stage feat/auth --yes --json | jq -r '.result.prUrl'
```

## Non-interactive use

venfork never waits on a prompt that nobody can answer. It does not prompt when any of these is true:

- stdin is not a terminal (a pipe, `/dev/null`, a CI runner, an agent)
- stderr is not a terminal (`2>log`, `2>/dev/null`), because prompts render on stderr and a hidden prompt would wait forever
- `CI` is set to anything except an empty string, `false` or `0`
- `VENFORK_NONINTERACTIVE=1` is set
- the command got `--no-input`

When venfork cannot prompt:

- A prompt with a default uses the default and logs it on stderr. Today that is only the `setup` mirror name (`{repo}-private`).
- A prompt without a default exits 2. The error on stderr names the argument or flag that supplies the value, for example `the <upstream> argument` or `--upstream <url>`.
- A confirm exits 2 and names `--yes`. Nothing is pushed or created.

`--yes` (`-y`) answers every confirm of that command with yes, with or without a terminal: the `setup` personal-account confirm, the `stage` push confirm, and the `stage issue` and `pull issue` confirms. It is the only way to give consent without a prompt. Every command accepts `--yes`, `-y` and `--no-input`, so a wrapper can always pass one fixed flag set; on a command with nothing to confirm or ask (`sync`, `doctor`, `pull pr`, `schedule`, `workflows`, `preserve`, and `clone` for `--yes`) they change nothing.

```bash
# In CI: never prompt, and confirm the push explicitly
venfork stage feat/auth --yes --no-input
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| `0` | Success, or you answered "no" to a confirm at a terminal |
| `1` | Runtime failure, `venfork doctor` found a failing check, or a partial success: `stage` pushed but could not open the PR, or a `pull pr` push to origin failed (the `--json` result says what landed) |
| `2` | Usage error (unknown command or option, missing or unexpected argument, malformed flag value, flags that cannot be combined, or bare `venfork` with no command), or missing input or consent: venfork could not prompt and no flag supplied the answer |
| `130` | Cancelled at a prompt (Ctrl-C, Esc, or input ended), interrupted by SIGINT, or the terminal closed during the run |
| `143` | Terminated by SIGTERM |

A usage error is reported before venfork checks gh auth or touches a repo. Input that is valid in form but fails against the repos, such as a branch that does not exist, a diverged mirror, or a flag that contradicts the mirror's `venfork-config`, is a runtime failure (`1`).

## Headless and CI use

venfork runs on a machine with no browser, no SSH key and nobody at the keyboard, for example a CI job, a container or an agent. A gh token is the only credential it needs.

1. Give gh a token. Set `GH_TOKEN` in the environment, or run `gh auth login --with-token < token.txt` once. The token needs access to the mirror, the public fork and upstream.
2. Use HTTPS for GitHub remotes: `gh config set git_protocol https`. Then clone the mirror, so that `gh repo clone` writes HTTPS remote URLs. A clone that already has SSH remotes keeps them.
3. Run venfork with `--no-input` (or `--json`, which implies it). Pass `--yes` to the commands that ask for consent. With `--json`, stdout carries one JSON document. See [Non-interactive use](#non-interactive-use) and [JSON output](#json-output).
4. Check the exit code: `0` success, `1` runtime failure or a failing doctor check, `2` usage error or missing input or consent, `130` cancelled, `143` terminated by SIGTERM.

```bash
export GH_TOKEN="$(cat /run/secrets/gh-token)"
gh config set git_protocol https
venfork clone acme/project-private --no-input --json
cd project-private
venfork doctor --json | jq '.result.checks[] | select(.id == "transport")'
venfork sync --json
venfork stage feat/auth --yes --json
```

You do not need `gh auth setup-git`. Every git fetch, push and ls-remote that venfork runs adds `-c credential.https://github.com.helper= -c credential.https://github.com.helper=!gh auth git-credential`. For `https://github.com`, gh is then the only credential helper in venfork's git calls: the helpers in your git config are not asked, and git never stores a gh token in them (a stored copy would go stale when gh refreshes its token). Your own helpers keep working for every other host and for git commands you run yourself. The helper applies only to `https://github.com` URLs, never to other hosts or local paths. When gh is missing or not authenticated, git fails at once with `terminal prompts disabled` and never waits on a prompt. `venfork doctor` shows the result in its `transport` check.

The scheduled sync workflow does not depend on this: actions/checkout stores the push token as an HTTP header in the checkout, and git sends that header on every fetch and push, so the push token still does the pushing.

## Environment Variables

### `NO_COLOR`

Set `NO_COLOR` to any non-empty value to get plain stderr output (no colors, no spinner animation) even in a terminal. `TERM=dumb` has the same effect. See [Output Streams](#output-streams).

### `VENFORK_ORG`

Set a default organization for all venfork commands. This avoids having to type `--org` every time.

**Priority order:**
1. `--org` flag (highest priority - always overrides)
2. `VENFORK_ORG` environment variable
3. Personal account (prompts for confirmation)

**Usage:**

```bash
# Set in your shell profile (~/.zshrc, ~/.bashrc, etc.)
export VENFORK_ORG=my-company

# Now all commands use this org by default
venfork setup git@github.com:client/project.git
# Creates: my-company/project-vendor (private), my-company/project (public fork)

# Override with --org flag when needed
venfork setup git@github.com:other-client/app.git --org different-org
# Creates: different-org/app-vendor (private), different-org/app (public fork)
```

**Safety feature:**
If neither `--org` nor `VENFORK_ORG` is set, venfork will prompt for confirmation before creating repos under your personal account. This prevents accidental personal repo creation when working as a vendor/contractor.

```bash
# Without VENFORK_ORG or --org
venfork setup git@github.com:client/project.git

# Output:
# ⚠️  No organization specified
# Repos will be created under your personal account (username: yourname)
# Continue with personal account? (y/N)
```

### `VENFORK_NONINTERACTIVE`

Set `VENFORK_NONINTERACTIVE=1` to make venfork never prompt, as if every command got `--no-input`. It does **not** answer confirms: a confirm without `--yes` exits 2. Pass `--yes` to give consent. See [Non-interactive use](#non-interactive-use).

```bash
VENFORK_NONINTERACTIVE=1 venfork stage feat/auth --yes
```

### `VENFORK_GIT_TIMEOUT`

Cap in milliseconds for each network git or gh operation (default `600000`, 10 minutes). Raise it for very large upstream repositories.

### `VENFORK_SEED_CHUNK` and `VENFORK_SEED_RETRY_MS`

When `venfork setup` seeds a new mirror, it pushes the default branch in batches of `VENFORK_SEED_CHUNK` commits (default `1000`) and retries a failed push with a backoff based on `VENFORK_SEED_RETRY_MS` (default `8000`).

### `VENFORK_ALLOW_SELF_REFERENCE`

Set `VENFORK_ALLOW_SELF_REFERENCE=1` for projects whose upstream legitimately mentions venfork. `venfork stage` then stops refusing the bare word `venfork` in commit messages, PR titles and PR bodies. Mirror URL, owner and repo name terms are never relaxed.

### `GITHUB_REPOSITORY`

GitHub Actions sets this. With `venfork sync --report-issues`, sync files the `venfork-sync-blocked` issue on that repository without a privacy lookup when it names `origin`. Otherwise sync asks gh whether origin is private first.

The generated workflow also reads the `VENFORK_PUSH_TOKEN` secret (or, with `schedule set --app`, the `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` secrets) and the `VENFORK_INSTALL_SPEC` repository variable; see `venfork schedule` above.

### Concurrency

Commands that mutate `venfork-config` (`stage`, `pull pr`, `stage issue` and `pull issue`) push to the orphan config branch with `--force-with-lease=venfork-config:<read-sha>`, leasing against the exact SHA the command read its starting state from.

When two venfork commands race the config update, the losing one's push is rejected with a "stale info" error. **venfork auto-handles this**: it re-reads the freshly-updated config (now including the winning run's changes), re-applies its own patch on top, and pushes again with the new lease SHA. Up to 3 retries before giving up.

That means concurrent runs are normally invisible to the user — both updates land. Only after sustained contention (3 lease failures in a row) does venfork surface the error and ask you to re-run the command. Don't `--force` the config branch by hand to "fix" a transient lease failure; that's exactly the data-loss path the lease prevents.

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

# Once approved internally, merge to main
git checkout main
git merge feature/user-auth
git push origin main
```

### Staging for Upstream

```bash
# When ready to contribute back
venfork stage feature/user-auth

# Output shows:
# ✓ Branch staged to public fork
# 🔗 Create PR: https://github.com/client/awesome-project/compare/...

# NOW visible to client
# Create PR from public fork → upstream
```

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

If you've staged a branch before and need to update it, run `venfork stage <branch>` again. Stage rebuilds the branch and replaces the public copy with `--force-with-lease`. Do not push the branch to the public fork with plain `git push`: that skips the checks above.

## Development

```bash
# Install dependencies (npm or bun)
npm install
# or
bun install

# Run tests
npm test
# or
bun run test

# Run tests in watch mode
npm run test:watch
# or
bun run test:watch

# Run tests with coverage
npm run test:coverage
# or
bun run test:coverage

# Run in development mode
npm run dev setup --help
# or
bun run dev setup --help

# Build
npm run build
# or
bun run build

# Link for local testing
npm link
# or
bun link

# Format code
npm run format

# Lint code
npm run lint

# Check and fix all issues
npm run check
```

## Tech Stack

- **Runtime:** Node.js 22+ (or Bun for faster development)
- **Language:** TypeScript (strict mode)
- **Shell Execution:** execa
- **CLI Framework:** @clack/prompts
- **Code Quality:** Biome

## License

MIT

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) to get started.

Key steps:
1. Fork and clone the repository
2. Install dependencies: `bun install`
3. Make your changes and add tests
4. Run checks: `bun run check && bun run test`
5. Use a conventional commit prefix (`feat:`, `fix:`, etc.) — release-please picks up the version bump from your commit message
6. Submit a pull request

## Support

If you encounter any issues or have questions:

1. Ensure you have the latest version installed
2. Open an issue on GitHub
---

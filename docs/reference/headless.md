# Headless, CI and environment variables

Running venfork without a terminal: prompts, `--yes`, exit codes, CI use and every environment variable.

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

`--yes` (`-y`) answers every confirm of that command with yes, with or without a terminal: the `setup` personal-account confirm, the `stage` push confirm, and the `stage issue` and `pull issue` confirms. It is the only way to give consent without a prompt. Every command accepts `--yes`, `-y` and `--no-input`, so a wrapper can always pass one fixed flag set; on a command with nothing to confirm or ask (`sync`, `doctor`, `pull pr`, `schedule`, `workflows`, `keep`, and `clone` for `--yes`) they change nothing.

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
3. Run venfork with `--no-input` (or `--json`, which implies it). Pass `--yes` to the commands that ask for consent. With `--json`, stdout carries one JSON document. See [Non-interactive use](#non-interactive-use) and [JSON output](json.md#json-output).
4. Check the exit code: `0` success, `1` runtime failure, a failing doctor check or a partial success (see the table above), `2` usage error or missing input or consent, `130` cancelled, `143` terminated by SIGTERM.

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

Set `NO_COLOR` to any non-empty value to get plain stderr output (no colors, no spinner animation) even in a terminal. `TERM=dumb` has the same effect. See [Output Streams](json.md#output-streams).

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
# Creates: my-company/project-private (private), my-company/project (public fork)

# Override with --org flag when needed
venfork setup git@github.com:other-client/app.git --org different-org
# Creates: different-org/app-private (private), different-org/app (public fork)
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

The generated workflow also reads the `VENFORK_PUSH_TOKEN` secret (or, with `schedule set --app`, the `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` secrets) and the `VENFORK_INSTALL_SPEC` repository variable; see [`venfork schedule`](scheduled-sync.md#venfork-schedule-statusset-cron---app--tokendisable---yes---no-input---json).

### Concurrency

Commands that mutate `venfork-config` (`stage`, `pull pr`, `stage issue`, `pull issue`, `keep add` and `keep remove`, `workflows allow`, `workflows block` and `workflows clear`, and `schedule set` and `schedule disable`) push to the orphan config branch with `--force-with-lease=venfork-config:<read-sha>`, leasing against the exact SHA the command read its starting state from.

When two venfork commands race the config update, the losing one's push is rejected with a "stale info" error. **venfork auto-handles this**: it re-reads the freshly-updated config (now including the winning run's changes), re-applies its own patch on top, and pushes again with the new lease SHA. It makes up to 3 attempts in total before it gives up.

`schedule set`, `schedule disable` and a `keep remove` of a file that the managed commit carries are the exception: they also push a new mirror tip, so they do not retry. A lost lease there fails the command, and you run it again.

That means concurrent runs are normally invisible to the user: both updates land. Only after sustained contention (3 lease failures in a row) does venfork surface the error and ask you to re-run the command. Don't `--force` the config branch by hand to "fix" a transient lease failure; that's exactly the data-loss path the lease prevents.

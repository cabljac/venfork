import { VENFORK_VERSION } from './version.js';

const WORKFLOW_NAME = 'Venfork Sync';
const WORKFLOW_FILENAME = '.github/workflows/venfork-sync.yml';

/** Repo-relative path of the managed sync workflow file. */
export function getSyncWorkflowPath(): string {
  return WORKFLOW_FILENAME;
}

/** Pinned by commit SHA so a moved tag cannot change what runs with the App key. */
export const CREATE_APP_TOKEN_ACTION =
  'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0';

/**
 * How the generated workflow authenticates its pushes. `'token'` reads the
 * `VENFORK_PUSH_TOKEN` secret. `'app'` mints a GitHub App installation token
 * from the `VENFORK_APP_CLIENT_ID` and `VENFORK_APP_PRIVATE_KEY` secrets,
 * scoped to the mirror and, in standard mode, `publicRepo`.
 */
export type SyncAuth =
  | { kind: 'token' }
  | { kind: 'app'; publicRepo?: { owner: string; name: string } };

const SAFE_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

function escapeCronForYaml(cron: string): string {
  // Double single quotes for YAML single-quoted scalars and normalize lines.
  return cron
    .replace(/'/g, "''")
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

interface AuthSteps {
  check: string;
  mint: string;
  checkoutToken: string;
  failureEnv: string;
  failureCause: string;
}

const TOKEN_AUTH_STEPS: AuthSteps = {
  check: `      - name: Check VENFORK_PUSH_TOKEN
        id: token-check
        shell: bash
        env:
          VENFORK_PUSH_TOKEN: \${{ secrets.VENFORK_PUSH_TOKEN }}
        run: |
          if [ -z "$VENFORK_PUSH_TOKEN" ]; then
            echo "::error::VENFORK_PUSH_TOKEN is not set on this repository. Create a fine-grained token with Contents and Workflows write for the mirror and the public fork, then: gh secret set VENFORK_PUSH_TOKEN --repo $GITHUB_REPOSITORY --body <token>"
            exit 1
          fi
`,
  mint: '',
  checkoutToken: 'secrets.VENFORK_PUSH_TOKEN',
  failureEnv: '',
  failureCause: `          if [ "$TOKEN_CHECK" = "failure" ]; then
            MESSAGE="$MESSAGE"$'\\n\\n'"Cause: the VENFORK_PUSH_TOKEN secret is not set. Create a fine-grained token with Contents and Workflows write for the mirror and the public fork, then run: gh secret set VENFORK_PUSH_TOKEN --repo $REPO --body <token>"
          fi
`,
};
function appAuthSteps(
  publicRepo: { owner: string; name: string } | undefined,
  noPublic: boolean
): AuthSteps {
  if (!noPublic && !publicRepo) {
    throw new Error('GitHub App auth in standard mode needs the public fork');
  }
  for (const segment of publicRepo ? [publicRepo.owner, publicRepo.name] : []) {
    if (!SAFE_REPO_SEGMENT.test(segment)) {
      throw new Error(`Unsafe public fork name for the workflow: ${segment}`);
    }
  }
  const ownerCheck = publicRepo
    ? `          OWNER="$(printf '%s' "$GITHUB_REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')"
          if [ "$OWNER" != "${publicRepo.owner.toLowerCase()}" ]; then
            echo "::error::The public fork ${publicRepo.owner}/${publicRepo.name} has a different owner than $GITHUB_REPOSITORY. One GitHub App installation token covers one owner, so switch this mirror to token auth: venfork schedule set <cron> --token"
            exit 1
          fi
`
    : '';
  const repositories = publicRepo
    ? `\${{ steps.token-check.outputs.mirror }},${publicRepo.name}`
    : `\${{ steps.token-check.outputs.mirror }}`;
  const installedOn = publicRepo
    ? `$REPO and ${publicRepo.owner}/${publicRepo.name}`
    : '$REPO';
  return {
    check: `      - name: Check VENFORK_APP_CLIENT_ID and VENFORK_APP_PRIVATE_KEY
        id: token-check
        shell: bash
        env:
          VENFORK_APP_CLIENT_ID: \${{ secrets.VENFORK_APP_CLIENT_ID }}
          VENFORK_APP_PRIVATE_KEY: \${{ secrets.VENFORK_APP_PRIVATE_KEY }}
        run: |
          MISSING=0
          if [ -z "$VENFORK_APP_CLIENT_ID" ]; then
            echo "::error::VENFORK_APP_CLIENT_ID is not set on this repository. Copy the GitHub App's client ID, then: gh secret set VENFORK_APP_CLIENT_ID --repo $GITHUB_REPOSITORY --body <client-id>"
            MISSING=1
          fi
          if [ -z "$VENFORK_APP_PRIVATE_KEY" ]; then
            echo "::error::VENFORK_APP_PRIVATE_KEY is not set on this repository. Generate a private key for the GitHub App, then: gh secret set VENFORK_APP_PRIVATE_KEY --repo $GITHUB_REPOSITORY < <key.pem>"
            MISSING=1
          fi
          if [ "$MISSING" -ne 0 ]; then
            exit 1
          fi
${ownerCheck}          echo "mirror=\${GITHUB_REPOSITORY#*/}" >> "$GITHUB_OUTPUT"
`,
    mint: `      - name: Mint GitHub App token
        id: app-token
        uses: ${CREATE_APP_TOKEN_ACTION}
        with:
          client-id: \${{ secrets.VENFORK_APP_CLIENT_ID }}
          private-key: \${{ secrets.VENFORK_APP_PRIVATE_KEY }}
          owner: \${{ github.repository_owner }}
          repositories: ${repositories}
          permission-contents: write
          permission-workflows: write
`,
    checkoutToken: 'steps.app-token.outputs.token',
    failureEnv: `          APP_TOKEN: \${{ steps.app-token.outcome }}
`,
    failureCause: `          if [ "$TOKEN_CHECK" = "failure" ]; then
            MESSAGE="$MESSAGE"$'\\n\\n'"Cause: the GitHub App secrets are not usable. Set both VENFORK_APP_CLIENT_ID and VENFORK_APP_PRIVATE_KEY (gh secret set VENFORK_APP_CLIENT_ID --repo $REPO --body <client-id>; gh secret set VENFORK_APP_PRIVATE_KEY --repo $REPO < <key.pem>)${publicRepo ? ', or see the run log when the public fork has a different owner' : ''}."
          elif [ "$APP_TOKEN" = "failure" ]; then
            MESSAGE="$MESSAGE"$'\\n\\n'"Cause: the GitHub App token could not be minted. Check that the App is installed on ${installedOn} with Contents and Workflows write, and that VENFORK_APP_PRIVATE_KEY holds a current private key for the App in VENFORK_APP_CLIENT_ID."
          fi
`,
  };
}

/**
 * Generates deterministic GitHub Actions workflow YAML for scheduled sync.
 *
 * In `'standard'` mode the workflow configures both `upstream` and `public`
 * remotes; in `'no-public'` mode the public-remote block is omitted so the
 * sync only mirrors upstream → origin.
 *
 * The runner installs exactly `version` (default: the running CLI), so the
 * YAML a runner regenerates matches the YAML already on the default branch.
 */
export function generateSyncWorkflow(
  cron: string,
  mode: 'standard' | 'no-public' = 'standard',
  version: string = VENFORK_VERSION,
  auth: SyncAuth = { kind: 'token' }
): string {
  const safeCron = escapeCronForYaml(cron);
  const noPublic = mode === 'no-public';
  const steps =
    auth.kind === 'app'
      ? appAuthSteps(noPublic ? undefined : auth.publicRepo, noPublic)
      : TOKEN_AUTH_STEPS;

  const remotesScript = noPublic
    ? `          set -euo pipefail
          git fetch origin venfork-config
          CONFIG_JSON="$(git show FETCH_HEAD:.venfork/config.json)"
          UPSTREAM_URL="$(node -e "const c = JSON.parse(process.argv[1]); process.stdout.write(c.upstreamUrl || '')" "$CONFIG_JSON")"
          if [ -z "$UPSTREAM_URL" ]; then
            echo "Missing upstream URL in venfork-config"
            exit 1
          fi
          git remote remove upstream 2>/dev/null || true
          git remote add upstream "$UPSTREAM_URL"
          git remote set-url --push upstream DISABLE`
    : `          set -euo pipefail
          git fetch origin venfork-config
          CONFIG_JSON="$(git show FETCH_HEAD:.venfork/config.json)"
          UPSTREAM_URL="$(node -e "const c = JSON.parse(process.argv[1]); process.stdout.write(c.upstreamUrl || '')" "$CONFIG_JSON")"
          PUBLIC_URL="$(node -e "const c = JSON.parse(process.argv[1]); process.stdout.write(c.publicForkUrl || '')" "$CONFIG_JSON")"
          if [ -z "$UPSTREAM_URL" ] || [ -z "$PUBLIC_URL" ]; then
            echo "Missing upstream/public URL in venfork-config"
            exit 1
          fi
          git remote remove upstream 2>/dev/null || true
          git remote remove public 2>/dev/null || true
          git remote add upstream "$UPSTREAM_URL"
          git remote set-url --push upstream DISABLE
          git remote add public "$PUBLIC_URL"`;

  return `name: ${WORKFLOW_NAME}
on:
  schedule:
    - cron: '${safeCron}'
  workflow_dispatch:

permissions:
  contents: write
  issues: write

concurrency:
  group: venfork-sync-\${{ github.workflow }}
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
${steps.check}      - name: Install venfork
        env:
          VENFORK_INSTALL_SPEC: \${{ vars.VENFORK_INSTALL_SPEC }}
        shell: bash
        run: |
          set -euo pipefail
          SPEC="\${VENFORK_INSTALL_SPEC:-venfork@${version}}"
          SEMVER_SPEC='^venfork@[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'
          TARBALL_SPEC='^https://[^[:space:]]+\\.tgz$'
          if ! [[ "$SPEC" =~ $SEMVER_SPEC ]] && ! [[ "$SPEC" =~ $TARBALL_SPEC ]]; then
            echo "::error::VENFORK_INSTALL_SPEC must be venfork@<semver> or an https:// URL ending in .tgz"
            exit 1
          fi
          npm install -g --ignore-scripts "$SPEC"
${steps.mint}      - name: Checkout mirror
        uses: actions/checkout@v4
        with:
          token: \${{ ${steps.checkoutToken} }}
          fetch-depth: 0
      - name: Rewrite SSH GitHub URLs to HTTPS
        shell: bash
        run: |
          set -euo pipefail
          # venfork-config can store SSH remote URLs (gh defaults to ssh).
          # actions/checkout's extraheader auth only applies to https://github.com/,
          # so rewrite SSH forms to HTTPS. --add is required: each insteadOf
          # value is a separate entry under the same key.
          git config --global --add url."https://github.com/".insteadOf "git@github.com:"
          git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
          git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com:22/"
          git config --global --add url."https://github.com/".insteadOf "ssh://git@ssh.github.com:443/"
          git config --global --add url."https://github.com/".insteadOf "git@GitHub.com:"
      - name: Configure venfork remotes
        shell: bash
        run: |
${remotesScript}
      - name: Sync from upstream
        id: sync
        env:
          GH_TOKEN: \${{ github.token }}
        run: venfork sync --report-issues
      - name: Report failed sync
        if: failure() && steps.sync.outputs.reported != 'true'
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
          TOKEN_CHECK: \${{ steps.token-check.outcome }}
${steps.failureEnv}        run: |
          set -euo pipefail
          REPO="$GITHUB_REPOSITORY"
          MESSAGE="Scheduled venfork sync failed. See $RUN_URL"
${steps.failureCause}          if ! gh label list --repo "$REPO" --search venfork-sync-blocked --json name --jq '.[].name' | grep -qx venfork-sync-blocked; then
            gh label create venfork-sync-blocked --repo "$REPO" --color B60205 --description "Scheduled venfork sync is blocked"
          fi
          NUMBER="$(gh api "repos/$REPO/issues?labels=venfork-sync-blocked&state=open&per_page=100" --jq 'map(select(.pull_request == null))[0].number // empty')"
          if [ -z "$NUMBER" ]; then
            gh issue create --repo "$REPO" --label venfork-sync-blocked --title "Scheduled sync failed" --body "$MESSAGE"
          # A blocked sync already wrote this run URL into the issue body.
          else
            BODY="$(gh issue view "$NUMBER" --repo "$REPO" --json body --jq '.body')"
            if ! grep -qF "$RUN_URL" <<<"$BODY"; then
              gh issue comment "$NUMBER" --repo "$REPO" --body "$MESSAGE"
            fi
          fi
`;
}

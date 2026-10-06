import { VENFORK_VERSION } from './version.js';

const WORKFLOW_NAME = 'Venfork Sync';
const WORKFLOW_FILENAME = '.github/workflows/venfork-sync.yml';

/** Repo-relative path of the managed sync workflow file. */
export function getSyncWorkflowPath(): string {
  return WORKFLOW_FILENAME;
}

function escapeCronForYaml(cron: string): string {
  // Double single quotes for YAML single-quoted scalars and normalize lines.
  return cron
    .replace(/'/g, "''")
    .replace(/[\r\n]+/g, ' ')
    .trim();
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
  version: string = VENFORK_VERSION
): string {
  const safeCron = escapeCronForYaml(cron);
  const noPublic = mode === 'no-public';

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
      - name: Check VENFORK_PUSH_TOKEN
        id: token-check
        shell: bash
        env:
          VENFORK_PUSH_TOKEN: \${{ secrets.VENFORK_PUSH_TOKEN }}
        run: |
          if [ -z "$VENFORK_PUSH_TOKEN" ]; then
            echo "::error::VENFORK_PUSH_TOKEN is not set on this repository. Create a fine-grained token with Contents and Workflows write for the mirror and the public fork, then: gh secret set VENFORK_PUSH_TOKEN --repo $GITHUB_REPOSITORY --body <token>"
            exit 1
          fi
      - name: Install venfork
        env:
          VENFORK_INSTALL_SPEC: \${{ vars.VENFORK_INSTALL_SPEC }}
        run: npm install -g --ignore-scripts "\${VENFORK_INSTALL_SPEC:-venfork@${version}}"
      - name: Checkout mirror
        uses: actions/checkout@v4
        with:
          token: \${{ secrets.VENFORK_PUSH_TOKEN }}
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
        env:
          GH_TOKEN: \${{ github.token }}
        run: venfork sync --report-issues
      - name: Report failed sync
        if: failure()
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
          TOKEN_CHECK: \${{ steps.token-check.outcome }}
        run: |
          set -euo pipefail
          REPO="$GITHUB_REPOSITORY"
          MESSAGE="Scheduled venfork sync failed. See $RUN_URL"
          if [ "$TOKEN_CHECK" = "failure" ]; then
            MESSAGE="$MESSAGE"$'\\n\\n'"Cause: the VENFORK_PUSH_TOKEN secret is not set. Create a fine-grained token with Contents and Workflows write for the mirror and the public fork, then run: gh secret set VENFORK_PUSH_TOKEN --repo $REPO --body <token>"
          fi
          if ! gh label list --repo "$REPO" --search venfork-sync-blocked --json name --jq '.[].name' | grep -qx venfork-sync-blocked; then
            gh label create venfork-sync-blocked --repo "$REPO" --color B60205 --description "Scheduled venfork sync is blocked"
          fi
          NUMBER="$(gh issue list --repo "$REPO" --label venfork-sync-blocked --state open --json number --limit 1 --jq '.[0].number // empty')"
          if [ -z "$NUMBER" ]; then
            gh issue create --repo "$REPO" --label venfork-sync-blocked --title "Scheduled sync failed" --body "$MESSAGE"
          # A blocked sync already wrote this run URL into the issue body.
          elif ! gh issue view "$NUMBER" --repo "$REPO" --json body --jq '.body' | grep -qF "$RUN_URL"; then
            gh issue comment "$NUMBER" --repo "$REPO" --body "$MESSAGE"
          fi
`;
}

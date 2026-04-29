const WORKFLOW_NAME = 'Venfork Sync';
const WORKFLOW_FILENAME = '.github/workflows/venfork-sync.yml';

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
 */
export function generateSyncWorkflow(
  cron: string,
  mode: 'standard' | 'no-public' = 'standard'
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

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout mirror
        uses: actions/checkout@v4
        with:
          token: \${{ secrets.VENFORK_PUSH_TOKEN || github.token }}
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
      - name: Install venfork
        run: npm install -g venfork
      - name: Configure venfork remotes
        shell: bash
        run: |
${remotesScript}
      - name: Sync from upstream
        run: venfork sync
`;
}

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
 */
export function generateSyncWorkflow(cron: string): string {
  const safeCron = escapeCronForYaml(cron);
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
      - name: Install venfork
        run: npm install -g venfork
      - name: Configure venfork remotes
        shell: bash
        run: |
          set -euo pipefail
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
          git remote add public "$PUBLIC_URL"
      - name: Sync from upstream
        run: venfork sync
`;
}

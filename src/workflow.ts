const WORKFLOW_NAME = 'Venfork Sync';
const WORKFLOW_FILENAME = '.github/workflows/venfork-sync.yml';

export function getSyncWorkflowPath(): string {
  return WORKFLOW_FILENAME;
}

/**
 * Generates deterministic GitHub Actions workflow YAML for scheduled sync.
 */
export function generateSyncWorkflow(cron: string): string {
  return `name: ${WORKFLOW_NAME}
on:
  schedule:
    - cron: '${cron}'
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
      - name: Sync from upstream
        run: venfork sync
`;
}

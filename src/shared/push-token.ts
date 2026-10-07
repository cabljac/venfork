import type { ScheduleAuth } from '../config.js';

/** The `gh secret set` command for the mirror's push token. */
export function pushTokenCommand(mirrorPath: string): string {
  return `gh secret set VENFORK_PUSH_TOKEN --repo ${mirrorPath} --body "<fine-grained token>"`;
}

/**
 * The `gh secret set` commands for the GitHub App secrets the sync workflow
 * mints its push token from.
 *
 * @param mirrorPath `owner/name` of the private mirror.
 */
export function appSecretCommands(mirrorPath: string): string[] {
  return [
    `gh secret set VENFORK_APP_CLIENT_ID --repo ${mirrorPath} --body "<client ID>"`,
    `gh secret set VENFORK_APP_PRIVATE_KEY --repo ${mirrorPath} < <private-key>.pem`,
  ];
}

/**
 * The `gh secret delete` commands for the secrets `auth` reads, for when a
 * mirror stops using them.
 *
 * @param mirrorPath `owner/name` of the private mirror.
 * @param auth The auth mode whose secrets are no longer read.
 */
export function secretDeleteCommands(
  mirrorPath: string,
  auth: ScheduleAuth
): string[] {
  const names =
    auth === 'app'
      ? ['VENFORK_APP_CLIENT_ID', 'VENFORK_APP_PRIVATE_KEY']
      : ['VENFORK_PUSH_TOKEN'];
  return names.map((name) => `gh secret delete ${name} --repo ${mirrorPath}`);
}

/**
 * How to mint `VENFORK_PUSH_TOKEN` without handing upstream the keys: a
 * token limited to the repositories sync pushes to. A repository secret is
 * readable by every workflow on the mirror's default branch, and upstream
 * ships those workflows unless the allow or block list filters them.
 *
 * @param mirrorPath `owner/name` of the private mirror.
 * @param noPublic True when there is no public fork to push to.
 */
export function pushTokenAdvice(mirrorPath: string, noPublic: boolean): string {
  const repos = noPublic
    ? `only ${mirrorPath}`
    : `only ${mirrorPath} and the public fork`;
  return [
    `Create a fine-grained personal access token for ${repos} with Contents: read and write and Workflows: read and write, then:`,
    `  ${pushTokenCommand(mirrorPath)}`,
    'Do not use `gh auth token`: it is your whole account, and any workflow upstream ships can read a secret on the mirror.',
    'To avoid a long-lived token, use a GitHub App instead: venfork schedule set "<cron>" --app',
  ].join('\n');
}

/**
 * How to set up the GitHub App the sync workflow mints a one-hour push
 * token from on each run. The App must be dedicated to this mirror: its key
 * reaches every repository the App is installed on.
 *
 * @param mirrorPath `owner/name` of the private mirror.
 * @param noPublic True when there is no public fork to push to.
 */
export function appAuthAdvice(mirrorPath: string, noPublic: boolean): string {
  const repos = noPublic
    ? `only ${mirrorPath}`
    : `only ${mirrorPath} and the public fork`;
  return [
    `Create one App per mirror (per client): a GitHub App with no webhook and the repository permissions Contents: read and write and Workflows: read and write. Install it on ${repos}, generate a private key, then:`,
    ...appSecretCommands(mirrorPath).map((command) => `  ${command}`),
    "Do not share the App between mirrors. VENFORK_APP_PRIVATE_KEY can mint a token for every repository the App is installed on; the workflow limits only the token it mints. A shared App turns one mirror's secret into write access on every mirror.",
    'Each run mints a token that expires after one hour. The private key does not expire: any workflow upstream ships can read a secret on the mirror.',
  ].join('\n');
}

/**
 * Warning for a mirror that runs every upstream workflow with the push
 * credential in reach.
 *
 * @param auth The auth mode, which decides the secret named.
 */
export function openWorkflowsWarning(auth: ScheduleAuth): string {
  const secret =
    auth === 'app' ? 'VENFORK_APP_PRIVATE_KEY' : 'VENFORK_PUSH_TOKEN';
  return `Every upstream workflow runs on the mirror and can read ${secret}. Block the ones you do not need: \`venfork workflows block <file>...\` (or \`venfork workflows allow <file>...\` to keep only some).`;
}

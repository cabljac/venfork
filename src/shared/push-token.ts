/** The `gh secret set` command for the mirror's push token. */
export function pushTokenCommand(mirrorPath: string): string {
  return `gh secret set VENFORK_PUSH_TOKEN --repo ${mirrorPath} --body "<fine-grained token>"`;
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
    `Create a fine-grained personal access token for ${repos} with Contents: read and write and Workflows: read and write (or a GitHub App with the same access), then:`,
    `  ${pushTokenCommand(mirrorPath)}`,
    'Do not use `gh auth token`: it is your whole account, and any workflow upstream ships can read a secret on the mirror.',
  ].join('\n');
}

/** Warning for a mirror that runs every upstream workflow with the token in reach. */
export const OPEN_WORKFLOWS_WARNING =
  'Every upstream workflow runs on the mirror and can read VENFORK_PUSH_TOKEN. Block the ones you do not need: `venfork workflows block <file>...` (or `venfork workflows allow <file>...` to keep only some).';

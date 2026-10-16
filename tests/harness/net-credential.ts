/** The argv netExec puts after `git`, joined with spaces. */
export const GH_CREDENTIAL_ARGS =
  '-c credential.https://github.com.helper= -c credential.https://github.com.helper=!gh auth git-credential';

function isGhCredential(value: unknown): boolean {
  return Array.isArray(value) && value.join(' ') === GH_CREDENTIAL_ARGS;
}

/**
 * Undoes netExec's credential injection on a template, so string-mocked
 * execa sees `git fetch origin` rather than `git -c credential... fetch
 * origin`. Any other template is returned unchanged.
 */
export function withoutGhCredential<T>(
  strings: TemplateStringsArray,
  values: T[]
): [TemplateStringsArray, T[]] {
  if (!isGhCredential(values[0]) || strings.length < 2) {
    return [strings, values];
  }
  const join = (parts: readonly string[]) => [
    parts[0] + parts[1].slice(1),
    ...parts.slice(2),
  ];
  return [
    Object.assign(join(strings), { raw: join(strings.raw) }),
    values.slice(1),
  ];
}

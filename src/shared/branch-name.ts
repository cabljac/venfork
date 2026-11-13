/** True when `name` is a literal Git branch name, not a revision expression. */
export function isLiteralBranchName(name: string): boolean {
  if (
    name.length === 0 ||
    name === '@' ||
    name === 'HEAD' ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.includes('//') ||
    name.includes('..') ||
    name.includes('@{') ||
    Array.from(name).some(
      (character) =>
        character.charCodeAt(0) <= 0x20 ||
        character.charCodeAt(0) === 0x7f ||
        '~^:?*[\\'.includes(character)
    )
  ) {
    return false;
  }
  return name
    .split('/')
    .every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

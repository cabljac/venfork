export type ParsedPreserveArgs = {
  action: 'list' | 'add' | 'remove' | 'clear';
  paths: string[];
};

/**
 * Parse `venfork preserve ...` argv after the `preserve` token.
 *
 * Path entries are taken verbatim — no comma-splitting — so paths that
 * happen to contain a comma still work. Pass each path as a separate argv
 * entry (`venfork preserve add path/one path/two`).
 */
export function parsePreserveCliArgs(
  preserveArgs: string[]
): ParsedPreserveArgs {
  const actionRaw = preserveArgs[0] ?? 'list';

  if (actionRaw === 'list') {
    return { action: 'list', paths: [] };
  }

  if (actionRaw === 'clear') {
    return { action: 'clear', paths: [] };
  }

  if (actionRaw === 'add' || actionRaw === 'remove') {
    const values = preserveArgs.slice(1).filter((entry) => entry.length > 0);
    if (values.length === 0) {
      throw new Error(
        `Usage: venfork preserve ${actionRaw} <path> [more-paths]`
      );
    }
    return { action: actionRaw, paths: values };
  }

  throw new Error('Usage: venfork preserve <list|add|remove|clear> [path ...]');
}

import { scanArgs, unexpectedArgument } from './shared/args.js';

export type ParsedPreserveArgs = {
  action: 'list' | 'add' | 'remove' | 'clear';
  paths: string[];
};

const USAGE = 'venfork preserve <list|add|remove|clear> [path ...]';

/**
 * Parse `venfork preserve ...` argv after the `preserve` token.
 *
 * Path entries are taken verbatim — no comma-splitting — so paths that
 * happen to contain a comma still work. Pass each path as a separate argv
 * entry (`venfork preserve add path/one path/two`). A path that starts
 * with `-` goes after `--`.
 */
export function parsePreserveCliArgs(
  preserveArgs: string[]
): ParsedPreserveArgs {
  const [actionRaw = 'list', ...rest] = scanArgs(
    preserveArgs,
    USAGE,
    () => undefined
  );

  if (actionRaw === 'list' || actionRaw === 'clear') {
    if (rest.length > 0) throw unexpectedArgument(rest[0], USAGE);
    return { action: actionRaw, paths: [] };
  }

  if (actionRaw === 'add' || actionRaw === 'remove') {
    const values = rest.filter((entry) => entry.length > 0);
    if (values.length === 0) {
      throw new Error(
        `Usage: venfork preserve ${actionRaw} <path> [more-paths]`
      );
    }
    return { action: actionRaw, paths: values };
  }

  throw new Error(`Usage: ${USAGE}`);
}

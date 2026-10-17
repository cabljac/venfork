import { normalizePreservePath } from './config.js';
import { UsageError } from './errors.js';
import { NO_INPUT_FLAG, scanArgs, unexpectedArgument } from './shared/args.js';
import { JSON_FLAG } from './shared/json-output.js';

/**
 * The clean form of each `preserve add` path. Throws {@link UsageError} for
 * a path that {@link normalizePreservePath} rejects.
 */
export function normalizePreserveArgs(paths: string[]): string[] {
  return paths.map((candidate) => {
    const cleaned = normalizePreservePath(candidate);
    if (!cleaned) {
      throw new UsageError(
        `Invalid preserve path '${candidate}': must be a clean relative path (no leading '/' or '-', no '..' / '.' / empty segments, no backslashes, NUL bytes, Windows drive prefixes, whitespace, glob characters (* ? [ ]) or leading ':'), and not the venfork sync workflow or a path under .venfork/.`
      );
    }
    return cleaned;
  });
}

export type ParsedPreserveArgs = {
  action: 'list' | 'add' | 'remove' | 'clear';
  paths: string[];
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

const USAGE =
  'venfork preserve <list|add|remove|clear> [path ...] [--no-input] [--json]';

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
  let json = false;
  const [actionRaw = 'list', ...rest] = scanArgs(preserveArgs, USAGE, (arg) => {
    if (arg === NO_INPUT_FLAG) return 0;
    if (arg !== JSON_FLAG) return undefined;
    json = true;
    return 0;
  });

  if (actionRaw === 'list' || actionRaw === 'clear') {
    if (rest.length > 0) throw unexpectedArgument(rest[0], USAGE);
    return { action: actionRaw, paths: [], json };
  }

  if (actionRaw === 'add' || actionRaw === 'remove') {
    const values = rest.filter((entry) => entry.length > 0);
    if (values.length === 0) {
      throw new UsageError(
        `Usage: venfork preserve ${actionRaw} <path> [more-paths]`
      );
    }
    return { action: actionRaw, paths: values, json };
  }

  throw new UsageError(`Usage: ${USAGE}`);
}

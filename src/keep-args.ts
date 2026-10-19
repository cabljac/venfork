import { normalizePreservePath } from './config.js';
import { UsageError } from './errors.js';
import { isPromptFlag, scanArgs, unexpectedArgument } from './shared/args.js';
import { JSON_FLAG } from './shared/json-output.js';

/**
 * The clean form of each `keep add` path. Throws {@link UsageError} for
 * a path that {@link normalizePreservePath} rejects.
 */
export function normalizeKeepArgs(paths: string[]): string[] {
  return paths.map((candidate) => {
    const cleaned = normalizePreservePath(candidate);
    if (!cleaned) {
      throw new UsageError(
        `Invalid keep path '${candidate}': must be a clean relative path (no leading '/' or '-', no '..' / '.' / empty segments, no backslashes, NUL bytes, Windows drive prefixes, whitespace, glob characters (* ? [ ]) or leading ':'), and not the venfork sync workflow or a path under .venfork/.`
      );
    }
    return cleaned;
  });
}

export type ParsedKeepArgs = {
  action: 'list' | 'add' | 'remove' | 'clear';
  paths: string[];
  /** Print the `--json` envelope on stdout. */
  json: boolean;
};

const USAGE =
  'venfork keep <list|add|remove|clear> [path ...] [--no-input] [--json]';

/**
 * Parse `venfork keep ...` argv after the `keep` token.
 *
 * Path entries are taken verbatim, with no comma-splitting, so paths that
 * happen to contain a comma still work. Pass each path as a separate argv
 * entry (`venfork keep add path/one path/two`). A path that starts
 * with `-` goes after `--`.
 */
export function parseKeepCliArgs(keepArgs: string[]): ParsedKeepArgs {
  let json = false;
  const [actionRaw = 'list', ...rest] = scanArgs(keepArgs, USAGE, (arg) => {
    if (isPromptFlag(arg)) return 0;
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
        `Usage: venfork keep ${actionRaw} <path> [more-paths]`
      );
    }
    return { action: actionRaw, paths: values, json };
  }

  throw new UsageError(`Usage: ${USAGE}`);
}

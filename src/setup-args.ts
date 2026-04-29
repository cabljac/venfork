export type ParsedSetupArgs = {
  upstreamUrl?: string;
  privateMirrorName?: string;
  organization?: string;
  publicForkRepoName?: string;
  noPublic: boolean;
};

/**
 * Parse `venfork setup ...` argv after the `setup` token.
 */
export function parseSetupCliArgs(setupArgs: string[]): ParsedSetupArgs {
  const positional: string[] = [];
  let organization: string | undefined;
  let publicForkRepoName: string | undefined;
  let noPublic = false;

  for (let i = 0; i < setupArgs.length; i++) {
    const a = setupArgs[i];
    if (a === '--org') {
      const val = setupArgs[++i];
      if (!val || val.startsWith('--'))
        throw new Error('--org requires a value');
      organization = val;
      continue;
    }
    if (a.startsWith('--org=')) {
      const val = a.slice('--org='.length);
      if (!val) throw new Error('--org requires a value');
      organization = val;
      continue;
    }
    if (a === '--fork-name') {
      const val = setupArgs[++i];
      if (!val || val.startsWith('--'))
        throw new Error('--fork-name requires a value');
      publicForkRepoName = val;
      continue;
    }
    if (a.startsWith('--fork-name=')) {
      const val = a.slice('--fork-name='.length);
      if (!val) throw new Error('--fork-name requires a value');
      publicForkRepoName = val;
      continue;
    }
    if (a === '--no-public') {
      noPublic = true;
      continue;
    }
    positional.push(a);
  }

  const trimmedForkName = publicForkRepoName?.trim() || undefined;
  if (noPublic && trimmedForkName) {
    throw new Error(
      '--no-public cannot be combined with --fork-name: --no-public skips creating a public fork entirely.'
    );
  }

  return {
    upstreamUrl: positional[0],
    privateMirrorName: positional[1],
    organization: organization ?? process.env.VENFORK_ORG,
    publicForkRepoName: trimmedForkName,
    noPublic,
  };
}

export type ParsedSetupArgs = {
  upstreamUrl?: string;
  privateMirrorName?: string;
  organization?: string;
  publicForkRepoName?: string;
};

/**
 * Parse `venfork setup ...` argv after the `setup` token.
 */
export function parseSetupCliArgs(setupArgs: string[]): ParsedSetupArgs {
  const positional: string[] = [];
  let organization: string | undefined;
  let publicForkRepoName: string | undefined;

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
      organization = a.slice('--org='.length);
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
      publicForkRepoName = a.slice('--fork-name='.length);
      continue;
    }
    positional.push(a);
  }

  return {
    upstreamUrl: positional[0],
    privateMirrorName: positional[1],
    organization: organization ?? process.env.VENFORK_ORG,
    publicForkRepoName: publicForkRepoName?.trim() || undefined,
  };
}

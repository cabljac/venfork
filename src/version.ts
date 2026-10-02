import pkg from '../package.json' with { type: 'json' };

/** Version of the running venfork CLI, inlined from package.json at build time. */
export const VENFORK_VERSION: string = pkg.version;

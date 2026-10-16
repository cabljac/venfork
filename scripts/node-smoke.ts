import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { createMirrorFixture } from '../tests/harness/mirror-fixture.js';
import {
  enginesFloorShortfall,
  nonBuiltinImports,
  runtimeDependencyEngines,
  verifyDoctorOutput,
} from './smoke-checks.js';

/**
 * Fails when a runtime dependency needs a newer Node than `engines.node`
 * admits. Packs the package, installs the tarball with `--omit=dev` into an empty
 * project, and runs its `venfork` bin under the `node` on PATH against a
 * local fixture: `--version` must print the package version and
 * `doctor --json` must exit 0 with the expected checks. Also fails when
 * dist/index.js imports anything but Node builtins, or when the install
 * pulls in any package besides venfork. Run after `bun run build`.
 */
const root = path.resolve(import.meta.dir, '..');
const { engines } = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8')
) as { engines: { node: string } };
const shortfall = enginesFloorShortfall(
  engines.node,
  await runtimeDependencyEngines(root)
);
if (shortfall.length > 0) {
  throw new Error(
    `engines.node ${engines.node} admits a Node older than ${shortfall.join(', ')} supports; raise engines.node`
  );
}
const bundle = await readFile(path.join(root, 'dist', 'index.js'), 'utf8');
const unbundled = nonBuiltinImports(bundle);
if (unbundled.length > 0) {
  throw new Error(
    `dist/index.js imports ${unbundled.join(', ')}; runtime code must be bundled, so it may import only Node builtins`
  );
}

const { version } = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8')
) as { version: string };
const tmp = await mkdtemp(path.join(os.tmpdir(), 'venfork-node-smoke-'));
const fx = await createMirrorFixture();
try {
  const npmEnv = { npm_config_cache: path.join(tmp, 'npm-cache') };
  const packDir = path.join(tmp, 'pack');
  await mkdir(packDir);
  const packed = await $({
    cwd: root,
    env: npmEnv,
  })`npm pack --json --ignore-scripts --pack-destination ${packDir}`;
  const [{ filename }] = JSON.parse(packed.stdout) as { filename: string }[];

  const project = path.join(tmp, 'project');
  await mkdir(project);
  await writeFile(
    path.join(project, 'package.json'),
    '{ "name": "venfork-node-smoke", "private": true }\n'
  );
  const install = await $({
    cwd: project,
    env: npmEnv,
    reject: false,
  })`npm install ${path.join(packDir, filename)} --omit=dev --no-package-lock --ignore-scripts --offline --no-audit --no-fund`;
  if (install.exitCode !== 0) {
    throw new Error(
      `offline npm install --omit=dev of the packed tarball failed; a runtime dependency in package.json "dependencies" needs the registry:\n${install.stderr}`
    );
  }

  const installed = (await readdir(path.join(project, 'node_modules'))).filter(
    (name) => !name.startsWith('.')
  );
  if (JSON.stringify(installed) !== JSON.stringify(['venfork'])) {
    throw new Error(
      `npm install --omit=dev installed ${installed.join(', ')}; want only venfork, so no runtime dependencies (no @clack, no execa)`
    );
  }

  const venfork = path.join(project, 'node_modules', '.bin', 'venfork');
  const reported = (await $`${venfork} --version`).stdout.trim();
  if (reported !== version) {
    throw new Error(`venfork --version printed ${reported}; want ${version}`);
  }

  const bin = path.join(tmp, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(bin, 'gh'), 0o755);

  const result = await $({
    cwd: fx.work,
    reject: false,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  })`${venfork} doctor --json`;

  const problem = verifyDoctorOutput(result.exitCode, result.stdout);
  if (problem) {
    throw new Error(
      `doctor --json under node ${process.version}: ${problem}\n${result.stderr}`
    );
  }
  console.log(
    `node ${(await $`node --version`).stdout}: the packed venfork ${version} installs with no dependencies and doctor --json printed the expected checks`
  );
} finally {
  await fx.cleanup();
  await rm(tmp, { recursive: true, force: true });
}

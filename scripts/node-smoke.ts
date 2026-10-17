import {
  chmod,
  mkdir,
  mkdtemp,
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
  runtimeDependencyEngines,
  verifyDoctorOutput,
} from './smoke-checks.js';

/**
 * Fails when a runtime dependency needs a newer Node than `engines.node`
 * admits, then runs the built CLI under the `node` on PATH against a local
 * fixture and checks that `doctor --json` exits 0 and prints the expected
 * checks, all ok. Run after `bun run build`.
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
const entry = path.join(root, 'dist', 'index.js');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'venfork-node-smoke-'));
const fx = await createMirrorFixture();
try {
  const bin = path.join(tmp, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(bin, 'gh'), 0o755);

  const result = await $({
    cwd: fx.work,
    reject: false,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  })`node ${entry} doctor --json`;

  const problem = verifyDoctorOutput(result.exitCode, result.stdout);
  if (problem) {
    throw new Error(
      `doctor --json under node ${process.version}: ${problem}\n${result.stderr}`
    );
  }
  console.log(
    `node ${(await $`node --version`).stdout}: doctor --json printed the expected checks`
  );
} finally {
  await fx.cleanup();
  await rm(tmp, { recursive: true, force: true });
}

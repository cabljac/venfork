import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { createMirrorFixture } from '../tests/harness/mirror-fixture.js';
import { verifyDoctorOutput } from './smoke-checks.js';

/**
 * Runs the built CLI under the `node` on PATH against a local fixture and
 * checks that `doctor --json` exits 0 and prints the expected checks, all ok.
 * Run after `bun run build`.
 */
const entry = path.resolve(import.meta.dir, '..', 'dist', 'index.js');
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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RELEASE_TARGETS } from './release-targets';

const rootDir = path.resolve(import.meta.dir, '..');
const distDir = path.join(rootDir, 'dist', 'targets');

const pkg = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package.json'), 'utf8')
) as { version: string };
const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${pkg.version}`) {
  console.error(
    `Release tag ${releaseTag} does not match package.json version ${pkg.version}`
  );
  process.exit(1);
}

await fs.mkdir(distDir, { recursive: true });

const results = await Promise.allSettled(
  RELEASE_TARGETS.map(async ({ bunTarget, platform }) => {
    const outfile = path.join(
      distDir,
      platform.startsWith('win32-')
        ? `venfork-${platform}.exe`
        : `venfork-${platform}`
    );
    const buildProc = Bun.spawn(
      [
        'bun',
        'build',
        'src/index.ts',
        '--compile',
        `--target=${bunTarget}`,
        '--outfile',
        outfile,
      ],
      { cwd: rootDir, stdout: 'inherit', stderr: 'inherit' }
    );

    const buildExit = await buildProc.exited;
    if (buildExit !== 0) {
      throw new Error(
        `Build failed for ${platform} (target: ${bunTarget}) with exit code ${buildExit}`
      );
    }

    console.log('Built', platform);
  })
);
const failures = results.filter(
  (r): r is PromiseRejectedResult => r.status === 'rejected'
);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(f.reason instanceof Error ? f.reason.message : f.reason);
  }
  console.error(
    `Release build failed for ${failures.length} of ${results.length} targets`
  );
  process.exit(1);
}

console.log('Built all platforms');

// The generated sync workflow pins `venfork@<version>` from the bundled
// package.json, so the shipped binary must report the version being released.
const hostPlatform = `${process.platform}-${process.arch}`;
const hostBinary = path.join(
  distDir,
  process.platform === 'win32'
    ? `venfork-${hostPlatform}.exe`
    : `venfork-${hostPlatform}`
);
const versionProc = Bun.spawn([hostBinary, '--version'], {
  cwd: rootDir,
  stdout: 'pipe',
  stderr: 'inherit',
});
const reported = (await new Response(versionProc.stdout).text()).trim();
if ((await versionProc.exited) !== 0 || reported !== pkg.version) {
  console.error(
    `Built binary reports version '${reported}', expected '${pkg.version}'`
  );
  process.exit(1);
}
console.log(`Verified ${hostPlatform} binary reports ${pkg.version}`);

import { promises as fs } from 'node:fs';
import path from 'node:path';

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

const TARGETS: { bunTarget: string; platform: string }[] = [
  { bunTarget: 'bun-darwin-arm64', platform: 'darwin-arm64' },
  { bunTarget: 'bun-darwin-x64', platform: 'darwin-x64' },
  { bunTarget: 'bun-linux-x64', platform: 'linux-x64' },
  { bunTarget: 'bun-linux-arm64', platform: 'linux-arm64' },
  { bunTarget: 'bun-windows-x64', platform: 'win32-x64' },
  { bunTarget: 'bun-windows-arm64', platform: 'win32-arm64' },
];

try {
  await Promise.all(
    TARGETS.map(async ({ bunTarget, platform }) => {
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
} catch (error) {
  console.error('Release build failed:', error);
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

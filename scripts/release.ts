import path from "node:path";
import { $ } from "bun";

const distDir = path.join(__dirname, "dist", "targets");

await $`mkdir -p ${distDir}`;

const TARGETS: { bunTarget: string; platform: string }[] = [
  { bunTarget: "bun-darwin-arm64", platform: "darwin-arm64" },
  { bunTarget: "bun-darwin-x64", platform: "darwin-x64" },
  { bunTarget: "bun-linux-x64", platform: "linux-x64" },
  { bunTarget: "bun-linux-arm64", platform: "linux-arm64" },
  { bunTarget: "bun-windows-x64", platform: "win32-x64" },
  { bunTarget: "bun-windows-arm64", platform: "win32-arm64" },
];


await Promise.all(
  TARGETS.map(async ({ bunTarget, platform }) => {
    const outfile = path.join(distDir, `venfork-${platform}`);
    const buildProc = Bun.spawn(
      [
        "bun",
        "build",
        "src/index.ts",
        "--compile",
        `--target=${bunTarget}`,
        "--outfile",
        outfile,
      ],
      { cwd: __dirname, stdout: "inherit", stderr: "inherit" },
    );

    const buildExit = await buildProc.exited;
    if (buildExit !== 0) process.exit(buildExit ?? 1);

    console.log("Built", platform);
  })
);

console.log("Built all platforms");
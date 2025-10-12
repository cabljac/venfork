import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';

/**
 * Venfork configuration structure
 */
export interface VenforkConfig {
  version: string;
  publicForkUrl: string;
  upstreamUrl: string;
}

const CONFIG_BRANCH = 'venfork-config';
const CONFIG_DIR = '.venfork';
const CONFIG_FILE = 'config.json';

/**
 * Creates and pushes a venfork config branch to the origin remote
 *
 * @param repoDir - Local repository directory
 * @param publicForkUrl - URL of the public fork repository
 * @param upstreamUrl - URL of the upstream repository
 */
export async function createConfigBranch(
  repoDir: string,
  publicForkUrl: string,
  upstreamUrl: string
): Promise<void> {
  // Create config object
  const config: VenforkConfig = {
    version: '1',
    publicForkUrl,
    upstreamUrl,
  };

  // Generate unique temp directory
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-${uniqueId}`);

  try {
    // Create temp directory structure
    await mkdir(path.join(tempDir, CONFIG_DIR), { recursive: true });

    // Write config file
    await writeFile(
      path.join(tempDir, CONFIG_DIR, CONFIG_FILE),
      JSON.stringify(config, null, 2)
    );

    // Initialize git repo in temp directory
    await $({ cwd: tempDir })`git init`;
    await $({ cwd: tempDir })`git checkout --orphan ${CONFIG_BRANCH}`;

    // Commit the config
    await $({ cwd: tempDir })`git add ${CONFIG_DIR}/${CONFIG_FILE}`;
    await $({
      cwd: tempDir,
    })`git commit -m ${'Initialize venfork configuration'}`;

    // Get the origin remote URL from the main repo
    const remoteResult = await $({ cwd: repoDir })`git remote get-url origin`;
    const originUrl = remoteResult.stdout.trim();

    // Push to origin
    await $({
      cwd: tempDir,
    })`git push ${originUrl} ${CONFIG_BRANCH}:${CONFIG_BRANCH} --force`;
  } finally {
    // Clean up temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Fetches and reads the venfork config from a repository
 *
 * @param repoUrl - Repository URL to fetch config from
 * @returns Config object if found, null otherwise
 */
export async function fetchVenforkConfig(
  repoUrl: string
): Promise<VenforkConfig | null> {
  // Generate unique temp directory
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-read-${uniqueId}`);

  try {
    // Try to clone just the config branch
    const cloneResult = await $({
      reject: false,
    })`git clone --branch ${CONFIG_BRANCH} --single-branch --depth 1 ${repoUrl} ${tempDir}`;

    if (cloneResult.exitCode !== 0) {
      // Config branch doesn't exist
      return null;
    }

    // Read the config file
    const configPath = path.join(tempDir, CONFIG_DIR, CONFIG_FILE);
    const readResult = await $({ reject: false })`cat ${configPath}`;

    if (readResult.exitCode !== 0) {
      return null;
    }

    const config = JSON.parse(readResult.stdout) as VenforkConfig;

    // Validate config structure
    if (!config.version || !config.publicForkUrl || !config.upstreamUrl) {
      return null;
    }

    return config;
  } catch {
    return null;
  } finally {
    // Clean up temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

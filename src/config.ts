import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { $ } from 'execa';
import { parseRepoPath } from './utils.js';

/**
 * Venfork configuration structure.
 */
export interface VenforkConfig {
  version: string;
  publicForkUrl: string;
  upstreamUrl: string;
  schedule?: {
    cron: string;
    enabled: boolean;
  };
}

const CONFIG_BRANCH = 'venfork-config';
const CONFIG_DIR = '.venfork';
const CONFIG_FILE = 'config.json';
const UPDATE_CONFIG_COMMIT_MESSAGE = 'chore: update venfork configuration';
const VENFORK_BOT_NAME = 'venfork-bot';
const VENFORK_BOT_EMAIL = 'venfork-bot@users.noreply.github.com';

/**
 * Creates and pushes a venfork config branch to the origin remote.
 */
export async function createConfigBranch(
  repoDir: string,
  publicForkUrl: string,
  upstreamUrl: string
): Promise<void> {
  const config: VenforkConfig = {
    version: '1',
    publicForkUrl,
    upstreamUrl,
  };

  await writeConfigBranch(repoDir, config, 'Initialize venfork configuration');
}

async function writeConfigBranch(
  repoDir: string,
  config: VenforkConfig,
  commitMessage: string
): Promise<void> {
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-${uniqueId}`);

  try {
    await mkdir(path.join(tempDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      path.join(tempDir, CONFIG_DIR, CONFIG_FILE),
      JSON.stringify(config, null, 2)
    );

    await $({ cwd: tempDir })`git init`;
    await $({ cwd: tempDir })`git checkout --orphan ${CONFIG_BRANCH}`;
    await $({ cwd: tempDir })`git add ${CONFIG_DIR}/${CONFIG_FILE}`;
    await $({
      cwd: tempDir,
    })`git -c user.name=${VENFORK_BOT_NAME} -c user.email=${VENFORK_BOT_EMAIL} commit -m ${commitMessage}`;

    const remoteResult = await $({ cwd: repoDir })`git remote get-url origin`;
    const originUrl = remoteResult.stdout.trim();
    await $({
      cwd: tempDir,
    })`git push ${originUrl} ${CONFIG_BRANCH}:${CONFIG_BRANCH} --force`;
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function normalizeConfig(config: VenforkConfig): VenforkConfig | null {
  if (!config.version || !config.publicForkUrl || !config.upstreamUrl) {
    return null;
  }

  if (config.schedule) {
    const cron = config.schedule.cron?.trim();
    if (!cron || typeof config.schedule.enabled !== 'boolean') {
      return null;
    }
    return {
      ...config,
      schedule: {
        cron,
        enabled: config.schedule.enabled,
      },
    };
  }

  return config;
}

/**
 * Fetches and reads the venfork config from a remote repository.
 */
export async function fetchVenforkConfig(
  repoUrl: string
): Promise<VenforkConfig | null> {
  const uniqueId = randomBytes(8).toString('hex');
  const tempDir = path.join(os.tmpdir(), `venfork-config-read-${uniqueId}`);

  try {
    const repoRef = parseRepoPath(repoUrl) || repoUrl;
    const cloneResult = await $({
      reject: false,
    })`gh repo clone ${repoRef} ${tempDir} -- --branch ${CONFIG_BRANCH} --single-branch --depth 1`;

    if (cloneResult.exitCode !== 0) {
      return null;
    }

    const rawConfig = await readFile(
      path.join(tempDir, CONFIG_DIR, CONFIG_FILE),
      'utf-8'
    );
    const config = JSON.parse(rawConfig) as VenforkConfig;
    return normalizeConfig(config);
  } catch {
    return null;
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Reads venfork configuration from the local repo's orphan `venfork-config` branch.
 */
export async function readVenforkConfigFromRepo(
  repoDir: string
): Promise<VenforkConfig | null> {
  const fetchResult = await $({
    cwd: repoDir,
    reject: false,
  })`git fetch origin ${CONFIG_BRANCH}`;
  if (fetchResult.exitCode !== 0) {
    return null;
  }

  const showResult = await $({
    cwd: repoDir,
    reject: false,
  })`git show FETCH_HEAD:${CONFIG_DIR}/${CONFIG_FILE}`;
  if (showResult.exitCode !== 0) {
    return null;
  }

  try {
    const config = JSON.parse(showResult.stdout) as VenforkConfig;
    return normalizeConfig(config);
  } catch {
    return null;
  }
}

/**
 * Updates and force-pushes `venfork-config` with a shallow merge patch.
 */
export async function updateVenforkConfig(
  repoDir: string,
  patch: Partial<VenforkConfig>
): Promise<VenforkConfig> {
  const current = await readVenforkConfigFromRepo(repoDir);
  if (!current) {
    throw new Error('venfork-config branch not found or invalid');
  }

  const merged: VenforkConfig = {
    ...current,
    ...patch,
    schedule: patch.schedule
      ? {
          ...current.schedule,
          ...patch.schedule,
        }
      : current.schedule,
  };

  if (merged.schedule && !merged.schedule.cron?.trim()) {
    throw new Error('schedule.cron is required when schedule is configured');
  }

  await writeConfigBranch(repoDir, merged, UPDATE_CONFIG_COMMIT_MESSAGE);
  return merged;
}

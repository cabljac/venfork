import { afterEach, describe, expect, test } from 'bun:test';
import { isolateGitEnv } from '../harness/env.js';

const KEYS = ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CUSTOM_LEAK', 'GH_TOKEN'];

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('isolateGitEnv', () => {
  test('hides GIT_* and token variables, applies overrides, and restores exactly', () => {
    process.env.GIT_DIR = '/elsewhere/.git';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GH_TOKEN = 'secret';
    const home = process.env.HOME;

    const restore = isolateGitEnv({
      HOME: '/fixture/home',
      GIT_CUSTOM_LEAK: 'x',
    });
    expect(process.env.GIT_DIR).toBeUndefined();
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.HOME).toBe('/fixture/home');
    restore();

    expect(process.env.GIT_DIR).toBe('/elsewhere/.git');
    expect(process.env.GIT_CONFIG_COUNT).toBe('1');
    expect(process.env.GH_TOKEN).toBe('secret');
    expect(process.env.HOME).toBe(home);
    expect(process.env.GIT_CUSTOM_LEAK).toBeUndefined();
  });

  test('nested isolation restores in reverse order', () => {
    process.env.GIT_DIR = '/outer';
    const restoreOuter = isolateGitEnv({ GIT_DIR: '/fixture-a' });
    const restoreInner = isolateGitEnv({ GIT_DIR: '/fixture-b' });
    restoreInner();
    expect(process.env.GIT_DIR).toBe('/fixture-a');
    restoreOuter();
    expect(process.env.GIT_DIR).toBe('/outer');
  });
});

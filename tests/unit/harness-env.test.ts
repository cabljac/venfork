import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isolateGitEnv } from '../harness/env.js';

const KEYS = [
  'GIT_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CUSTOM_LEAK',
  'GH_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'GH_ENTERPRISE_TOKEN',
  'VENFORK_ORG',
  'VENFORK_INSTALL_SPEC',
  'HARNESS_OVERRIDE_ONLY',
];
let saved: Map<string, string | undefined>;
const env = (key: string): string | undefined => process.env[key];

beforeEach(() => {
  saved = new Map(KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('isolateGitEnv', () => {
  test('hides GIT_* and token variables, applies overrides, and restores exactly', () => {
    process.env.GIT_DIR = '/elsewhere/.git';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GH_TOKEN = 'secret';
    delete process.env.GIT_CUSTOM_LEAK;
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

  test('hides every GH_* and VENFORK_* variable', () => {
    process.env.GH_HOST = 'ghe.example.com';
    process.env.GH_CONFIG_DIR = '/home/dev/.config/gh';
    process.env.GH_ENTERPRISE_TOKEN = 'secret';
    process.env.VENFORK_ORG = 'acme';
    process.env.VENFORK_INSTALL_SPEC = 'venfork@0.0.1';

    const restore = isolateGitEnv({});
    const inside = {
      GH_HOST: env('GH_HOST'),
      GH_CONFIG_DIR: env('GH_CONFIG_DIR'),
      GH_ENTERPRISE_TOKEN: env('GH_ENTERPRISE_TOKEN'),
      VENFORK_ORG: env('VENFORK_ORG'),
      VENFORK_INSTALL_SPEC: env('VENFORK_INSTALL_SPEC'),
    };
    restore();

    expect(inside).toEqual({
      GH_HOST: undefined,
      GH_CONFIG_DIR: undefined,
      GH_ENTERPRISE_TOKEN: undefined,
      VENFORK_ORG: undefined,
      VENFORK_INSTALL_SPEC: undefined,
    });
    expect(process.env.GH_HOST).toBe('ghe.example.com');
    expect(process.env.VENFORK_ORG).toBe('acme');
  });

  test('restores override keys that are not isolated keys', () => {
    delete process.env.HARNESS_OVERRIDE_ONLY;
    const restore = isolateGitEnv({ HARNESS_OVERRIDE_ONLY: 'fixture' });
    expect(env('HARNESS_OVERRIDE_ONLY')).toBe('fixture');
    restore();
    expect(env('HARNESS_OVERRIDE_ONLY')).toBeUndefined();

    process.env.HARNESS_OVERRIDE_ONLY = 'parent';
    const restoreAgain = isolateGitEnv({ HARNESS_OVERRIDE_ONLY: 'fixture' });
    restoreAgain();
    expect(env('HARNESS_OVERRIDE_ONLY')).toBe('parent');
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

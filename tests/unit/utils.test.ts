import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REPO_NAME,
  githubUrlForProtocol,
  githubUrlRepoPath,
  normalizeGitHubRepoInput,
  parseOwner,
  parseRepoName,
  parseRepoPath,
} from '../../src/utils';

describe('normalizeGitHubRepoInput', () => {
  test('converts owner/repo to SSH URL with .git', () => {
    expect(normalizeGitHubRepoInput('invertase/react-native-firebase')).toBe(
      'git@github.com:invertase/react-native-firebase.git'
    );
  });

  test('trims whitespace', () => {
    expect(normalizeGitHubRepoInput('  org/repo  ')).toBe(
      'git@github.com:org/repo.git'
    );
  });

  test('leaves SSH github URLs unchanged', () => {
    const u = 'git@github.com:invertase/react-native-firebase.git';
    expect(normalizeGitHubRepoInput(u)).toBe(u);
  });

  test('leaves SSH without .git unchanged', () => {
    const u = 'git@github.com:org/project';
    expect(normalizeGitHubRepoInput(u)).toBe(u);
  });

  test('leaves HTTPS github URLs unchanged', () => {
    const u = 'https://github.com/vuejs/core.git';
    expect(normalizeGitHubRepoInput(u)).toBe(u);
  });

  test('returns empty string for non-github URLs', () => {
    expect(normalizeGitHubRepoInput('https://gitlab.com/a/b.git')).toBe('');
  });

  test('returns empty string for bare github.com/owner/repo without scheme', () => {
    expect(normalizeGitHubRepoInput('github.com/owner/repo')).toBe('');
  });

  test('returns empty when empty', () => {
    expect(normalizeGitHubRepoInput('')).toBe('');
  });

  test('does not double .git for owner/repo.git shorthand', () => {
    expect(normalizeGitHubRepoInput('owner/repo.git')).toBe(
      'git@github.com:owner/repo.git'
    );
  });
});

describe('parseRepoName', () => {
  test('extracts repo name from SSH URL with .git', () => {
    expect(parseRepoName('git@github.com:facebook/react.git')).toBe('react');
  });

  test('extracts repo name from SSH URL without .git', () => {
    expect(parseRepoName('git@github.com:facebook/react')).toBe('react');
  });

  test('extracts repo name from HTTPS URL with .git', () => {
    expect(parseRepoName('https://github.com/vercel/next.js.git')).toBe(
      'next.js'
    );
  });

  test('extracts repo name from HTTPS URL without .git', () => {
    expect(parseRepoName('https://github.com/vercel/next.js')).toBe('next.js');
  });

  test('extracts repo name with hyphens', () => {
    expect(parseRepoName('git@github.com:microsoft/vscode-js-debug.git')).toBe(
      'vscode-js-debug'
    );
  });

  test('extracts repo name with dots', () => {
    expect(parseRepoName('https://github.com/vuejs/vue.js.git')).toBe('vue.js');
  });

  test('returns default for invalid URL', () => {
    expect(parseRepoName('not-a-valid-url')).toBe(DEFAULT_REPO_NAME);
  });

  test('returns default for empty string', () => {
    expect(parseRepoName('')).toBe(DEFAULT_REPO_NAME);
  });

  test('extracts repo name from URL with www', () => {
    expect(parseRepoName('https://www.github.com/facebook/react.git')).toBe(
      'react'
    );
  });
});

describe('parseRepoPath', () => {
  test.each([
    ['trailing slash', 'https://github.com/acme/w-private/', 'acme/w-private'],
    ['.git with trailing slash', 'https://github.com/acme/w.git/', 'acme/w'],
    ['ssh URL with port', 'ssh://git@github.com:22/acme/w', 'acme/w'],
    ['ssh URL without port', 'ssh://git@github.com/acme/w.git', 'acme/w'],
    ['ssh over port 443', 'ssh://git@ssh.github.com:443/acme/w.git', 'acme/w'],
    [
      'https with credentials',
      'https://x-access-token:t@github.com/acme/w',
      'acme/w',
    ],
  ])('normalizes %s', (_label, input, expected) => {
    expect(parseRepoPath(input)).toBe(expected);
  });

  test.each([
    ['look-alike host', 'https://evilgithub.com/acme/w'],
    ['github.com as a subpath', 'https://evil.example/github.com/acme/w'],
    ['other host', 'git@gitlab.com:acme/w.git'],
    ['owner only', 'https://github.com/acme'],
    ['extra path segments', 'https://github.com/acme/w/tree/main'],
    ['local path', '/tmp/fixture/origin.git'],
  ])('rejects %s', (_label, input) => {
    expect(parseRepoPath(input)).toBe('');
  });

  test('accepts owner/repo shorthand directly', () => {
    expect(parseRepoPath('firebase/extensions')).toBe('firebase/extensions');
  });

  test('accepts owner/repo.git shorthand directly', () => {
    expect(parseRepoPath('firebase/extensions.git')).toBe(
      'firebase/extensions'
    );
  });

  test('extracts owner/repo from SSH URL with .git', () => {
    expect(parseRepoPath('git@github.com:facebook/react.git')).toBe(
      'facebook/react'
    );
  });

  test('extracts owner/repo from SSH URL without .git', () => {
    expect(parseRepoPath('git@github.com:facebook/react')).toBe(
      'facebook/react'
    );
  });

  test('extracts owner/repo from HTTPS URL with .git', () => {
    expect(parseRepoPath('https://github.com/vercel/next.js.git')).toBe(
      'vercel/next.js'
    );
  });

  test('extracts owner/repo from HTTPS URL without .git', () => {
    expect(parseRepoPath('https://github.com/vercel/next.js')).toBe(
      'vercel/next.js'
    );
  });

  test('extracts owner/repo with hyphens and dots', () => {
    expect(parseRepoPath('git@github.com:microsoft/vscode-js-debug.git')).toBe(
      'microsoft/vscode-js-debug'
    );
  });

  test('returns empty string for invalid URL', () => {
    expect(parseRepoPath('not-a-valid-url')).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(parseRepoPath('')).toBe('');
  });

  test('extracts owner/repo from URL with www', () => {
    expect(parseRepoPath('https://www.github.com/facebook/react.git')).toBe(
      'facebook/react'
    );
  });

  test('handles organization with dots', () => {
    expect(parseRepoPath('https://github.com/my.org/project.git')).toBe(
      'my.org/project'
    );
  });
});

describe('parseOwner', () => {
  test('extracts owner from SSH URL with .git', () => {
    expect(parseOwner('git@github.com:facebook/react.git')).toBe('facebook');
  });

  test('extracts owner from SSH URL without .git', () => {
    expect(parseOwner('git@github.com:facebook/react')).toBe('facebook');
  });

  test('extracts owner from HTTPS URL with .git', () => {
    expect(parseOwner('https://github.com/vercel/next.js.git')).toBe('vercel');
  });

  test('extracts owner from HTTPS URL without .git', () => {
    expect(parseOwner('https://github.com/vercel/next.js')).toBe('vercel');
  });

  test('extracts owner with hyphens', () => {
    expect(parseOwner('git@github.com:my-company/project.git')).toBe(
      'my-company'
    );
  });

  test('extracts owner with dots', () => {
    expect(parseOwner('https://github.com/my.org/project.git')).toBe('my.org');
  });

  test('returns empty string for invalid URL', () => {
    expect(parseOwner('not-a-valid-url')).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(parseOwner('')).toBe('');
  });

  test('extracts owner from URL with www', () => {
    expect(parseOwner('https://www.github.com/facebook/react.git')).toBe(
      'facebook'
    );
  });
});

describe('githubUrlRepoPath', () => {
  test('reads owner/repo from a github.com URL only', () => {
    expect(githubUrlRepoPath('git@github.com:acme/widget.git\n')).toBe(
      'acme/widget'
    );
    expect(githubUrlRepoPath('https://github.com/acme/widget')).toBe(
      'acme/widget'
    );
    for (const url of [
      'acme/widget',
      '../mirror.git',
      'mirrors/x.git',
      '/tmp/origin.git',
      'gh:acme/widget',
    ]) {
      expect(githubUrlRepoPath(url)).toBe('');
    }
  });
});

describe('githubUrlForProtocol', () => {
  test.each([
    [
      'git@github.com:acme/widget.git',
      'https',
      'https://github.com/acme/widget.git',
    ],
    ['https://github.com/acme/widget', 'ssh', 'git@github.com:acme/widget.git'],
    [
      'ssh://git@github.com/acme/widget.git',
      'https',
      'https://github.com/acme/widget.git',
    ],
  ] as const)('rewrites %s for %s', (url, protocol, expected) => {
    expect(githubUrlForProtocol(url, protocol)).toBe(expected);
  });

  test.each([
    'git@git.example.com:team/widget.git',
    'https://gitlab.com/team/widget.git',
    '/tmp/fixture/upstream.git',
    'acme/widget',
  ])('keeps %s unchanged', (url) => {
    expect(githubUrlForProtocol(url, 'https')).toBe(url);
  });

  test('keeps the URL when gh reports no protocol', () => {
    expect(githubUrlForProtocol('git@github.com:acme/widget.git', null)).toBe(
      'git@github.com:acme/widget.git'
    );
  });
});

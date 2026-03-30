import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REPO_NAME,
  normalizeGitHubRepoInput,
  parseOwner,
  parseRepoName,
  parseRepoPath,
} from '../src/utils';

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

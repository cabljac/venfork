import { describe, expect, test } from 'bun:test';
import { DEFAULT_REPO_NAME, parseRepoName, parseRepoPath } from '../src/utils';

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

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const commandsDir = path.join(repoRoot, 'src', 'commands');
const featuresDir = path.join(
  repoRoot,
  '.agents',
  'skills',
  'verify-venfork',
  'references',
  'features'
);

/** Feature-map files that are not about one command. */
const CROSS_CUTTING = new Set([
  'README.md',
  'leak-invariants.md',
  'multi-command-journeys.md',
]);
const HEADINGS = [
  '## What exists',
  '## How a user reaches it',
  '## How to drive it',
  '## What proves it',
  '## What usually lies',
];
const FRONTMATTER_KEYS = ['command', 'entry', 'shared', 'config', 'tests'];

function commandNames(): string[] {
  return readdirSync(commandsDir)
    .filter((file) => file.endsWith('.ts') && file !== 'help.ts')
    .map((file) => file.slice(0, -'.ts'.length))
    .sort();
}

function featureNames(): string[] {
  return readdirSync(featuresDir)
    .filter((file) => file.endsWith('.md') && !CROSS_CUTTING.has(file))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();
}

/** Top-level keys of the YAML frontmatter, or null when there is none. */
function frontmatter(markdown: string): Map<string, string> | null {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const keys = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const key = line.match(/^([a-z]+):\s*(.*)$/);
    if (key) keys.set(key[1], key[2]);
  }
  return keys;
}

describe('verify-venfork feature map', () => {
  test('every command module has a feature file', () => {
    const missing = commandNames().filter(
      (name) => !existsSync(path.join(featuresDir, `${name}.md`))
    );

    expect(missing).toEqual([]);
  });

  test('every feature file belongs to a command module', () => {
    expect(featureNames()).toEqual(commandNames());
  });

  test('every feature file has the frontmatter keys, its module as entry and the five sections in order', () => {
    for (const name of featureNames()) {
      const markdown = readFileSync(
        path.join(featuresDir, `${name}.md`),
        'utf8'
      );
      const keys = frontmatter(markdown);
      expect({ name, keys: keys ? [...keys.keys()] : null }).toEqual({
        name,
        keys: FRONTMATTER_KEYS,
      });
      expect({ name, entry: keys?.get('entry') }).toEqual({
        name,
        entry: `src/commands/${name}.ts`,
      });
      const headings = markdown
        .split('\n')
        .filter((line) => line.startsWith('## '));
      expect({ name, headings }).toEqual({ name, headings: HEADINGS });
    }
  });
});

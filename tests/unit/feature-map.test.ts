import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const commandsDir = path.join(repoRoot, 'src', 'commands');
const sharedDir = path.join(repoRoot, 'src', 'shared');
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

/** Every list value in the frontmatter, keyed by its dotted path (`config.read`, `shared`). */
function frontmatterLists(markdown: string): Map<string, string[]> {
  const body = markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const lists = new Map<string, string[]>();
  let parent = '';
  for (const line of body.split('\n')) {
    const entry = line.match(/^(\s*)([a-z]+):\s*(.*)$/);
    if (!entry) continue;
    const [, indent, key, value] = entry;
    if (indent === '') parent = key;
    const name = indent === '' ? key : `${parent}.${key}`;
    const list = value.match(/^\[(.*)\]$/);
    if (list) {
      lists.set(
        name,
        list[1]
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      );
    }
  }
  return lists;
}

/** Field names of the `VenforkConfig` interface, read from the source. */
function venforkConfigFields(): string[] {
  const file = path.join(repoRoot, 'src', 'config.ts');
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest
  );
  const fields: string[] = [];
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'VenforkConfig') {
      for (const member of node.members) {
        if (member.name && ts.isIdentifier(member.name)) {
          fields.push(member.name.text);
        }
      }
    }
  });
  return fields;
}

/** Top-level command names dispatched by the `src/index.ts` switch. */
function dispatchedCommands(): string[] {
  const index = readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8');
  return [...index.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1]);
}

function featureFiles(): Array<{ name: string; markdown: string }> {
  return featureNames().map((name) => ({
    name,
    markdown: readFileSync(path.join(featuresDir, `${name}.md`), 'utf8'),
  }));
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

  test('every tests: path in the frontmatter exists', () => {
    const missing: string[] = [];
    for (const { name, markdown } of featureFiles()) {
      for (const [key, items] of frontmatterLists(markdown)) {
        if (!key.startsWith('tests.')) continue;
        for (const item of items) {
          if (!existsSync(path.join(repoRoot, item))) {
            missing.push(`${name}: ${item}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test('every config: key in the frontmatter is a VenforkConfig field', () => {
    const fields = new Set(venforkConfigFields());
    expect(fields.size).toBeGreaterThan(0);
    const unknown: string[] = [];
    for (const { name, markdown } of featureFiles()) {
      for (const [key, items] of frontmatterLists(markdown)) {
        if (!key.startsWith('config.')) continue;
        for (const item of items) {
          if (!fields.has(item)) unknown.push(`${name}: ${item}`);
        }
      }
    }

    expect(unknown).toEqual([]);
  });

  test('every shared: entry in the frontmatter is a module in src/shared', () => {
    const unknown: string[] = [];
    for (const { name, markdown } of featureFiles()) {
      for (const item of frontmatterLists(markdown).get('shared') ?? []) {
        if (!existsSync(path.join(sharedDir, `${item}.ts`))) {
          unknown.push(`${name}: ${item}`);
        }
      }
    }

    expect(unknown).toEqual([]);
  });

  test('every command dispatched by src/index.ts has a feature file', () => {
    const covered = new Set(
      featureFiles().flatMap(({ markdown }) =>
        (markdown.match(/^command:\s*(.*)$/m)?.[1] ?? '')
          .split(',')
          .map((usage) => usage.trim().split(/\s+/)[0])
      )
    );
    const commands = dispatchedCommands();
    expect(commands.length).toBeGreaterThan(0);

    expect(commands.filter((command) => !covered.has(command))).toEqual([]);
  });
});

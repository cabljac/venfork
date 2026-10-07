import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { commandHelp } from '../../src/commands/help';

const ROOT = path.resolve(import.meta.dir, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const readme = read('README.md');
const claudeMd = read('CLAUDE.md');

const dispatched = [
  ...read('src/index.ts').matchAll(/^ {4}case '([a-z-]+)':/gm),
].map((m) => m[1]);

interface ReadmeSection {
  commands: string[];
  body: string;
}

function commandSections(): ReadmeSection[] {
  const sections: ReadmeSection[] = [];
  let current: ReadmeSection | null = null;
  for (const line of readme.split('\n')) {
    if (/^#{1,3} /.test(line)) {
      current = null;
      if (line.startsWith('### `venfork ')) {
        const commands = [...line.matchAll(/`venfork ([a-z-]+)/g)].map(
          (m) => m[1]
        );
        current = { commands, body: line };
        sections.push(current);
      }
      continue;
    }
    if (current) current.body += `\n${line}`;
  }
  return sections;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function envVarsReadInSrc(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /(?:env\.|secrets\.|vars\.)(VENFORK_[A-Z_]+)/g
    )) {
      if (!m[1].startsWith('VENFORK_E2E')) found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe('README matches the CLI contract', () => {
  test('every dispatched command has a README heading', () => {
    expect(dispatched.length).toBeGreaterThan(0);
    const documented = new Set(commandSections().flatMap((s) => s.commands));
    const missing = dispatched.filter((c) => !documented.has(c));
    expect(missing).toEqual([]);
  });

  test('no README command heading names an undispatched command', () => {
    const documented = new Set(commandSections().flatMap((s) => s.commands));
    const unknown = [...documented].filter((c) => !dispatched.includes(c));
    expect(unknown).toEqual([]);
  });

  test('every VENFORK_* variable read in src is in the README and CLAUDE.md', () => {
    const vars = envVarsReadInSrc();
    expect(vars).toContain('VENFORK_PUSH_TOKEN');
    const envSection = claudeMd
      .split(/^## /m)
      .find((s) => s.startsWith('Environment variables'));
    expect(envSection).toBeDefined();
    expect(vars.filter((v) => !readme.includes(v))).toEqual([]);
    expect(vars.filter((v) => !envSection?.includes(v))).toEqual([]);
  });

  test('every flag in a command help usage appears in its README section', () => {
    const sections = commandSections();
    const missing: string[] = [];
    for (const command of dispatched) {
      const help = commandHelp(command);
      expect(help).not.toBeNull();
      const usage = (help ?? '')
        .split('\n')
        .filter((line) => line.startsWith('venfork '))
        .join('\n');
      const body = sections
        .filter((s) => s.commands.includes(command))
        .map((s) => s.body)
        .join('\n');
      for (const flag of new Set(usage.match(/--[a-z][a-z-]*/g) ?? [])) {
        if (!body.includes(flag)) missing.push(`${command} ${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

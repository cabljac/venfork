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

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return full.endsWith('.md') ? [full] : [];
  });
}

/** `VENFORK_*` identifiers in src that are code constants, not env vars. */
const NOT_ENV_VARS = new Set([
  'VENFORK_BOT_EMAIL',
  'VENFORK_BOT_NAME',
  'VENFORK_ONLY_KEYS',
  'VENFORK_VERSION',
]);

function envVarsNamedInSrc(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bVENFORK_[A-Z0-9_]+\b/g)) {
      if (!m[0].startsWith('VENFORK_E2E') && !NOT_ENV_VARS.has(m[0])) {
        found.add(m[0]);
      }
    }
  }
  return [...found].sort();
}

const mentions = (text: string, word: string) =>
  new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(text);

/** Usage lines of a command's help, indented or not. */
function usageLines(command: string): string[] {
  return (commandHelp(command) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`venfork ${command}`));
}

function readmeBody(command: string): string {
  return commandSections()
    .filter((s) => s.commands.includes(command))
    .map((s) => s.body)
    .join('\n');
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

  test('every VENFORK_* variable named in src is in the README and CLAUDE.md', () => {
    const vars = envVarsNamedInSrc();
    expect(vars).toContain('VENFORK_PUSH_TOKEN');
    const envSection = claudeMd
      .split(/^## /m)
      .find((s) => s.startsWith('Environment variables'));
    expect(envSection).toBeDefined();
    expect(vars.filter((v) => !mentions(readme, v))).toEqual([]);
    expect(vars.filter((v) => !mentions(envSection ?? '', v))).toEqual([]);
  });

  test('every flag in a command help usage appears in its README section', () => {
    const missing: string[] = [];
    for (const command of dispatched) {
      expect(commandHelp(command)).not.toBeNull();
      const usage = usageLines(command).join('\n');
      const body = readmeBody(command);
      for (const flag of new Set(usage.match(/--[a-z][a-z-]*/g) ?? [])) {
        if (!mentions(body, flag)) missing.push(`${command} ${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('docs never name `--pr` outside the alias sentence', () => {
    const docFiles = ['README.md', 'CLAUDE.md'];
    const stray: string[] = [];
    for (const file of docFiles) {
      const sentences = read(file).split(/(?<=[.!?])\s+|\n/);
      for (const sentence of sentences) {
        if (!mentions(sentence, '--pr')) continue;
        if (/accepted for one release/.test(sentence)) continue;
        stray.push(`${file}: ${sentence.trim()}`);
      }
    }
    expect(stray).toEqual([]);
  });

  test('every verify-venfork stage drive on the fixture passes --no-pr', () => {
    const files = markdownFiles(
      path.join(ROOT, '.agents/skills/verify-venfork')
    );
    expect(files.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const raw of lines) {
        if (raw.includes('Cannot open an upstream PR')) continue;
        const line = raw.replace(/\s#\s.*$/, '');
        for (const m of line.matchAll(
          /(?:\bvenfork|\bvf_yes|"\$VF_CLI")\s+stage\s+([^\s`;|<>&#)]+)/g
        )) {
          const target = m[1] ?? '';
          if (target === 'issue' || target.startsWith('-')) continue;
          const rest = line.slice(m.index ?? 0).split(/[;|`]|&&/)[0] ?? '';
          if (/<[a-z-]+>|\[/.test(rest)) continue;
          if (rest.trim() === 'venfork stage branch issue') continue;
          if (!mentions(rest, '--no-pr')) {
            missing.push(`${path.relative(ROOT, file)}: ${rest.trim()}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every subcommand in a command help usage appears in its README section', () => {
    const missing: string[] = [];
    for (const command of dispatched) {
      const body = readmeBody(command);
      for (const line of usageLines(command)) {
        const sub = line.split(/\s+/)[2];
        if (!sub || !/^[a-z][a-z-]*$/.test(sub)) continue;
        if (!mentions(body, `venfork ${command} ${sub}`)) {
          missing.push(`${command} ${sub}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('no README sentence says a command rejects a prompt flag every command accepts', () => {
    const rejectsPromptFlag = (line: string) =>
      /(does not|doesn't|cannot|never) (take|accept)s? `(--yes|-y|--no-input)`/.test(
        line
      ) ||
      /`(--yes|-y|--no-input)`[^.]*(only where|only on|refus|reject|usage error)/.test(
        line
      ) ||
      /(refus|reject)[^.]*`(--yes|-y|--no-input)`/.test(line);
    for (const stale of [
      '`clone` has no confirm, so it does not take `--yes`.',
      '`--yes` is accepted only where a confirm exists: `setup`, `stage`, `stage issue` and `pull issue`.',
      '`sync` refuses `--yes`.',
      '`--yes` on `doctor` is a usage error.',
    ]) {
      expect(rejectsPromptFlag(stale)).toBe(true);
    }
    expect(readme.split('\n').filter(rejectsPromptFlag)).toEqual([]);
    expect(readme).toContain(
      'Every command accepts `--yes`, `-y` and `--no-input`'
    );
  });
});

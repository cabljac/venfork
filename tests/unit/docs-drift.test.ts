import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { commandHelp } from '../../src/commands/help';

const ROOT = path.resolve(import.meta.dir, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const readme = read('README.md');
const claudeMd = read('CLAUDE.md');

const REFERENCE_DIR = 'docs/reference';
const referencePages = readdirSync(path.join(ROOT, REFERENCE_DIR))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => `${REFERENCE_DIR}/${name}`);
/** The user docs: the README front page, then every reference page. */
const docPages = ['README.md', ...referencePages];
const userDocs = docPages.map(read).join('\n');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes. */
function anchorOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

function anchorsIn(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = !fenced && /^#{1,6} (.*)$/.exec(line);
    if (heading) anchors.add(anchorOf(heading[1]));
  }
  return anchors;
}

const dispatched = [
  ...read('src/index.ts').matchAll(/^ {4}case '([a-z-]+)':/gm),
].map((m) => m[1]);

interface ReadmeSection {
  commands: string[];
  /** The section text below its `###` heading line. */
  body: string;
}

function commandSections(): ReadmeSection[] {
  const sections: ReadmeSection[] = [];
  let current: ReadmeSection | null = null;
  let fenced = false;
  for (const line of userDocs.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && /^#{1,3} /.test(line)) {
      current = null;
      if (line.startsWith('### `venfork ')) {
        const commands = [...line.matchAll(/`venfork ([a-z-]+)/g)].map(
          (m) => m[1]
        );
        current = { commands, body: '' };
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

/** Where the docs live on GitHub; links from the npm README and the CLI use it. */
const REPO_BLOB = 'https://github.com/cabljac/venfork/blob/main/';

/** A link target as a repo-relative path, or null when it leaves the repo. */
function repoPath(page: string, target: string): string | null {
  if (target.startsWith(REPO_BLOB)) return target.slice(REPO_BLOB.length);
  if (/^[a-z]+:/.test(target)) return null;
  const [file, anchor] = target.split('#');
  const resolved = file
    ? path.posix.normalize(path.posix.join(path.posix.dirname(page), file))
    : page;
  return anchor === undefined ? resolved : `${resolved}#${anchor}`;
}

const linkTargets = (markdown: string) =>
  [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);

/** Each sentence or line of the user docs. */
const docSentences = (file: string) =>
  read(file)
    .split(/(?<=[.!?])\s+|\n/)
    .map((sentence) => sentence.trim());

const mentions = (text: string, word: string) =>
  new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(text);

/** Usage lines of a command's help, indented or not. */
function usageLines(command: string): string[] {
  return (commandHelp(command) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`venfork ${command}`));
}

/**
 * Subcommand names a usage line offers: a literal third word (`pull pr`),
 * or each alternative of a `<a|b>` group (`schedule <status|set <cron>|disable>`).
 */
function subcommandsOf(line: string): string[] {
  const rest = line.split(/\s+/).slice(2).join(' ');
  if (/^[a-z][a-z-]*(\s|$)/.test(rest)) return [rest.split(/\s+/)[0]];
  if (!rest.startsWith('<')) return [];
  const alternatives: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of rest) {
    if (char === '<' || char === '[') depth++;
    if (char === '>' || char === ']') depth--;
    if (depth === 0) break;
    if (char === '|' && depth === 1) {
      alternatives.push(current);
      current = '';
    } else if (!(char === '<' && depth === 1 && current === '')) {
      current += char;
    }
  }
  alternatives.push(current);
  if (alternatives.length < 2) return [];
  return alternatives
    .map((alt) => alt.trim().split(/\s+/)[0])
    .filter((word) => /^[a-z][a-z-]*$/.test(word));
}

/** Parser usage strings: every `*USAGE = '...'` constant in src/*-args.ts. */
function parserUsages(): string[] {
  return readdirSync(path.join(ROOT, 'src'))
    .filter((name) => name.endsWith('-args.ts'))
    .flatMap((name) => [
      ...read(`src/${name}`).matchAll(/USAGE =\s*'([^']+)'/g),
    ])
    .map((m) => m[1]);
}

function readmeBody(command: string): string {
  return commandSections()
    .filter((s) => s.commands.includes(command))
    .map((s) => s.body)
    .join('\n');
}

describe('the user docs match the CLI contract', () => {
  test('every dispatched command has a heading in the user docs', () => {
    expect(dispatched.length).toBeGreaterThan(0);
    const documented = new Set(commandSections().flatMap((s) => s.commands));
    const missing = dispatched.filter((c) => !documented.has(c));
    expect(missing).toEqual([]);
  });

  test('no command heading in the user docs names an undispatched command', () => {
    const documented = new Set(commandSections().flatMap((s) => s.commands));
    const unknown = [...documented].filter((c) => !dispatched.includes(c));
    expect(unknown).toEqual([]);
  });

  test('every VENFORK_* variable named in src is in the user docs and CLAUDE.md', () => {
    const vars = envVarsNamedInSrc();
    expect(vars).toContain('VENFORK_PUSH_TOKEN');
    const envSection = claudeMd
      .split(/^## /m)
      .find((s) => s.startsWith('Environment variables'));
    expect(envSection).toBeDefined();
    expect(vars.filter((v) => !mentions(userDocs, v))).toEqual([]);
    expect(vars.filter((v) => !mentions(envSection ?? '', v))).toEqual([]);
  });

  test('every flag in a command help usage appears in its docs section', () => {
    const missing: string[] = [];
    for (const command of dispatched) {
      expect(commandHelp(command)).not.toBeNull();
      const usage = usageLines(command).join('\n');
      const body = readmeBody(command);
      for (const flag of new Set(usage.match(/--[a-z][a-z-]*/g) ?? [])) {
        if (flag === '--yes') continue; // one sentence covers every command
        if (!mentions(body, flag)) missing.push(`${command} ${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('docs never name `--pr` outside the alias sentence', () => {
    const docFiles = [...docPages, 'CLAUDE.md'];
    const stray: string[] = [];
    for (const file of docFiles) {
      for (const sentence of docSentences(file)) {
        if (!mentions(sentence, '--pr')) continue;
        if (/accepted for one release/.test(sentence)) continue;
        stray.push(`${file}: ${sentence}`);
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

  test('every subcommand in a command help usage appears in its docs section', () => {
    const missing: string[] = [];
    for (const command of dispatched) {
      const body = readmeBody(command);
      for (const line of usageLines(command)) {
        for (const sub of subcommandsOf(line)) {
          if (!mentions(body, `venfork ${command} ${sub}`)) {
            missing.push(`${command} ${sub}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('no docs sentence says a command rejects a prompt flag every command accepts', () => {
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
    expect(userDocs.split('\n').filter(rejectsPromptFlag)).toEqual([]);
    expect(userDocs).toContain(
      'Every command accepts `--yes`, `-y` and `--no-input`'
    );
  });

  test('subcommand alternatives in a usage group are expanded', () => {
    expect(
      subcommandsOf(
        'venfork schedule <status|set <cron> [--app|--token]|disable> [--json]'
      )
    ).toEqual(['status', 'set', 'disable']);
    expect(subcommandsOf('venfork pull pr <n>')).toEqual(['pr']);
    expect(subcommandsOf('venfork stage <branch> [--draft]')).toEqual([]);
  });

  test('every parser usage string is a usage line of its command help', () => {
    const usages = parserUsages();
    expect(usages.length).toBeGreaterThan(dispatched.length / 2);
    const missing = usages.filter((usage) => {
      const [, command, sub] = usage.split(/\s+/);
      const lines = [commandHelp(command, [sub]), commandHelp(command)]
        .join('\n')
        .split('\n')
        .map((line) => line.trim());
      if (lines.includes(usage)) return false;
      // A dispatch summary (`pull <pr|issue> ...`) is covered by one usage line per alternative.
      const alternatives = sub?.startsWith('<') ? subcommandsOf(usage) : [];
      return (
        alternatives.length === 0 ||
        !alternatives.every((alt) =>
          lines.some((line) => line.startsWith(`venfork ${command} ${alt} `))
        )
      );
    });
    expect(missing).toEqual([]);
  });

  test('every command help opens with a parser usage string', () => {
    const usages = new Set(parserUsages());
    const missing = dispatched.filter((command) => {
      const first = (commandHelp(command) ?? '').split('\n')[0];
      return first.startsWith(`venfork ${command}`) && !usages.has(first);
    });
    expect(missing).toEqual([]);
  });

  test('the user docs use current names and plain words', () => {
    const stale = ['vendor-repo', '+0/+1'].filter((term) =>
      userDocs.includes(term)
    );
    expect(stale).toEqual([]);
  });

  test('the user docs name a removed command form only to say it is a usage error', () => {
    const removed = [
      /`?venfork preserve\b/,
      /(?<![\w-])--no-public\b/,
      /venfork sync [a-z<][^\s`]*/,
    ];
    const stray = docPages.flatMap((file) =>
      docSentences(file)
        .filter((sentence) => removed.some((re) => re.test(sentence)))
        .filter((sentence) => !/is a usage error/.test(sentence))
        .map((sentence) => `${file}: ${sentence}`)
    );
    expect(stray).toEqual([]);
  });

  test('the docs describe stage as opening the upstream PR', () => {
    const stale = docPages.flatMap((file) =>
      docSentences(file)
        .filter((sentence) =>
          /Create PR from public fork|Create PR:|Branch staged to public fork/.test(
            sentence
          )
        )
        .map((sentence) => `${file}: ${sentence}`)
    );
    expect(stale).toEqual([]);
  });

  test('the docs never tell users to push their own commits to the mirror default branch', () => {
    const stray = docPages.flatMap((file) =>
      docSentences(file)
        .filter((sentence) => /^git push origin (main|master)\b/.test(sentence))
        .map((sentence) => `${file}: ${sentence}`)
    );
    expect(stray).toEqual([]);
  });

  test('the README front page stays short', () => {
    expect(readme.split('\n').length).toBeLessThanOrEqual(200);
  });

  test('the README links every reference page', () => {
    expect(referencePages.length).toBeGreaterThan(0);
    const linked = new Set(
      linkTargets(readme).map(
        (target) => repoPath('README.md', target)?.split('#')[0]
      )
    );
    const unlinked = referencePages.filter((page) => !linked.has(page));
    expect(unlinked).toEqual([]);
  });

  test('the README links other repo files by GitHub URL, since npm ships only the README', () => {
    const relative = linkTargets(readme).filter(
      (target) => !/^[a-z]+:/.test(target) && !target.startsWith('#')
    );
    expect(relative).toEqual([]);
  });

  test('CLI text points at docs by GitHub URL, never a bare docs path', () => {
    const bare: string[] = [];
    const urls: string[] = [];
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      for (const m of text.matchAll(/(\S*)docs\/reference\//g)) {
        if (m[1].endsWith(REPO_BLOB)) continue;
        bare.push(`${rel}: ${m[0]}`);
      }
      for (const m of text.matchAll(
        /https:\/\/github\.com\/cabljac\/venfork\/blob\/main\/[^\s'"`)#]+/g
      )) {
        urls.push(m[0]);
      }
    }
    expect(bare).toEqual([]);
    expect(urls.length).toBeGreaterThan(0);
    const missing = urls.filter(
      (url) => !existsSync(path.join(ROOT, url.slice(REPO_BLOB.length)))
    );
    expect(missing).toEqual([]);
  });

  test('every repo link in the user docs reaches a file and heading', () => {
    const broken: string[] = [];
    for (const page of docPages) {
      const text = read(page);
      for (const target of linkTargets(text)) {
        const local = repoPath(page, target);
        if (local === null) continue;
        const [resolved, anchor] = local.split('#');
        let body: string;
        try {
          body = read(resolved);
        } catch {
          broken.push(`${page} -> ${target}`);
          continue;
        }
        if (anchor && !anchorsIn(body).has(anchor)) {
          broken.push(`${page} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

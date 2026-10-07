import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** One rule violation at a 1-based line of a repo-relative file. */
export interface Finding {
  file: string;
  line: number;
  message: string;
}

/** A source file: repo-relative POSIX path and its text. */
export interface Source {
  file: string;
  text: string;
}

/** A rule checks one source file. */
export type Rule = (src: Source) => Finding[];

interface Scanned {
  /** The text with comments blanked out; offsets and newlines kept. */
  code: string;
  /** Template literals as [start, end) offsets, backticks included. */
  templates: Array<{ start: number; end: number }>;
}

/** Blanks comments and lists every template literal, nested ones included. */
export function scan(text: string): Scanned {
  const out = text.split('');
  const templates: Scanned['templates'] = [];
  const open: number[] = [];
  const exprDepth: number[] = [];
  let depth = 0;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < text.length) {
    const c = text[i];
    if (open.length > exprDepth.length) {
      if (c === '\\') i += 2;
      else if (c === '`') {
        templates.push({ start: open.pop() as number, end: i + 1 });
        i++;
      } else if (c === '$' && text[i + 1] === '{') {
        exprDepth.push(depth++);
        i += 2;
      } else i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '//' || two === '/*') {
      const close =
        two === '//' ? text.indexOf('\n', i) : text.indexOf('*/', i);
      const end = close < 0 ? text.length : close + (two === '/*' ? 2 : 0);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== '\n') {
        i += text[i] === '\\' ? 2 : 1;
      }
    } else if (c === '`') open.push(i);
    else if (c === '{') depth++;
    else if (c === '}' && exprDepth.at(-1) === --depth) exprDepth.pop();
    i++;
  }
  return { code: out.join(''), templates };
}

const lineOf = (text: string, index: number) =>
  text.slice(0, index).split('\n').length;

const body = (text: string, t: { start: number; end: number }) =>
  text.slice(t.start + 1, t.end - 1);

/** Name of the tag call before a template: `netExec` for netExec(cwd)`...`. */
function tagName(code: string, start: number): string {
  let j = start - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (code[j] === ')') {
    for (let d = 0; j >= 0; j--) {
      if (code[j] === ')') d++;
      else if (code[j] === '(' && --d === 0) break;
    }
    j--;
  }
  return /[\w$.]*$/.exec(code.slice(0, j + 1))?.[0] ?? '';
}

const PLUMBING =
  /^git\s+(?:-c\s+\S+\s+)*(?:rev-parse|rev-list|merge-base|diff|log|cat-file|show)\b/;
const SHORT_REF = /(?<![\w/.-])(?:upstream|origin|public)\/(?=\$\{|\w)/;

/** Rule 1: plumbing and commit resolvers get `refs/remotes/<r>/<b>`, never `<r>/<b>`. */
export const remoteRefs: Rule = ({ file, text }) => {
  const { code, templates } = scan(text);
  const found: Finding[] = [];
  for (const t of templates) {
    const raw = body(text, t);
    if (PLUMBING.test(raw) && SHORT_REF.test(raw)) {
      found.push({
        file,
        line: lineOf(text, t.start),
        message: `short remote ref passed to git plumbing; use refs/remotes/<remote>/<branch>: \`${raw.split('\n')[0]}\``,
      });
    }
  }
  const resolver =
    /\b(?:resolveCommit|revParse)\(\s*[`'"](?:upstream|origin|public)\//g;
  for (const m of code.matchAll(resolver)) {
    found.push({
      file,
      line: lineOf(text, m.index),
      message:
        'short remote ref passed to a commit resolver; use refs/remotes/',
    });
  }
  return found;
};

/** Rule 2: every `git push` runs as a netExec template (src/shared/net.ts). */
export const pushViaNet: Rule = ({ file, text }) => {
  const { code, templates } = scan(text);
  const found: Finding[] = [];
  for (const t of templates) {
    if (!/^git\s+(?:(?:-c\s+\S+|\$\{[^}]*\})\s+)*push\b/.test(body(text, t))) {
      continue;
    }
    const tag = tagName(code, t.start);
    if (tag !== '' && tag !== 'netExec') {
      found.push({
        file,
        line: lineOf(text, t.start),
        message: `git push run through \`${tag}\`; use netExec from src/shared/net.ts`,
      });
    }
  }
  if (file !== 'src/shared/net.ts') {
    for (const m of code.matchAll(/['"]push['"]/g)) {
      found.push({
        file,
        line: lineOf(text, m.index),
        message:
          "'push' as an argv element bypasses netExec; push with a netExec template",
      });
    }
  }
  return found;
};

/** Rule 3: commands never import other commands; shared never imports commands. */
export const importBoundary: Rule = ({ file, text }) => {
  const inCommands = file.startsWith('src/commands/');
  if (!inCommands && !file.startsWith('src/shared/')) return [];
  const { code } = scan(text);
  const found: Finding[] = [];
  const spec =
    /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)['"](\.[^'"]+)['"]/gm;
  for (const m of code.matchAll(spec)) {
    const target = path.posix.join(path.posix.dirname(file), m[1]);
    const intoCommands =
      target.startsWith('src/commands/') ||
      /^src\/commands\.[jt]s$/.test(target);
    if (intoCommands) {
      found.push({
        file,
        line: lineOf(text, m.index),
        message: `${inCommands ? 'a command' : 'src/shared'} imports ${target}; move the shared code to src/shared/`,
      });
    }
  }
  return found;
};

/** Rule 4: a file that creates or edits a PR or issue scans the text first. */
export const denyListCoverage: Rule = ({ file, text }) => {
  const { code, templates } = scan(text);
  const covered =
    /import\s*\{[^}]*\bassertNoMirrorReference\b[^}]*\}\s*from/.test(code) &&
    /\bassertNoMirrorReference\s*\(/.test(code);
  if (covered) return [];
  return templates
    .filter((t) => /^gh\s+(?:pr|issue)\s+(?:create|edit)\b/.test(body(text, t)))
    .map((t) => ({
      file,
      line: lineOf(text, t.start),
      message: `\`${body(text, t).split(/\s+/).slice(0, 3).join(' ')}\` in a file that does not import and call assertNoMirrorReference`,
    }));
};

/** Rule 5: only src/index.ts ends the process. */
export const noProcessExit: Rule = ({ file, text }) => {
  if (!/^src\/(?:commands|shared)\//.test(file)) return [];
  const { code } = scan(text);
  return [...code.matchAll(/\bprocess\.exit\s*\(/g)].map((m) => ({
    file,
    line: lineOf(text, m.index),
    message: 'process.exit outside src/index.ts; throw a VenforkError instead',
  }));
};

/** Every invariant rule, keyed by the name printed in findings. */
export const rules: Record<string, Rule> = {
  'remote-refs': remoteRefs,
  'push-via-net': pushViaNet,
  'import-boundary': importBoundary,
  'deny-list-coverage': denyListCoverage,
  'no-process-exit': noProcessExit,
};

/** Runs every rule over the given sources. */
export function lintSources(
  sources: Source[]
): Array<Finding & { rule: string }> {
  return sources.flatMap((src) =>
    Object.entries(rules).flatMap(([rule, check]) =>
      check(src).map((f) => ({ ...f, rule }))
    )
  );
}

function listTs(root: string, dir: string): string[] {
  const entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return listTs(root, full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..');
  const sources = listTs(root, 'src').map((file) => ({
    file,
    text: readFileSync(path.join(root, file), 'utf8'),
  }));
  const findings = lintSources(sources);
  for (const f of findings) {
    console.error(`${f.file}:${f.line}  [${f.rule}] ${f.message}`);
  }
  if (findings.length > 0) {
    console.error(`\n${findings.length} invariant violation(s).`);
    process.exit(1);
  }
  console.log(`Invariants hold across ${sources.length} files.`);
}

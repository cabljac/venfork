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
  /** The text with comments and regex literal bodies blanked; offsets and newlines kept. */
  code: string;
  /** `code` with string and template literal text blanked too; `${}` expressions kept. */
  bare: string;
  /** Template literals as [start, end) offsets, backticks included. */
  templates: Array<{ start: number; end: number }>;
}

/** A `/` after one of these starts a regex literal, not a division. */
const REGEX_AFTER_PUNCT = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_AFTER_KEYWORD =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function startsRegex(code: string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (j < 0) return true;
  const before = code.slice(Math.max(0, j - 11), j + 1).join('');
  return REGEX_AFTER_PUNCT.test(before) || REGEX_AFTER_KEYWORD.test(before);
}

/** End offset of the regex literal opening at `i`, flags included; -1 if the line ends first. */
function regexEnd(text: string, i: number): number {
  let inClass = false;
  for (let k = i + 1; k < text.length && text[k] !== '\n'; k++) {
    const ch = text[k];
    if (ch === '\\') k++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let end = k + 1;
      while (/[a-z]/i.test(text[end] ?? '')) end++;
      return end;
    }
  }
  return -1;
}

/**
 * Blanks comments and regex literal bodies, and lists every template literal,
 * nested ones included. Also returns a copy with literal text blanked.
 */
export function scan(text: string): Scanned {
  const code = text.split('');
  const bare = text.split('');
  const templates: Scanned['templates'] = [];
  const open: number[] = [];
  const exprDepth: number[] = [];
  let depth = 0;
  let i = 0;
  const blank = (to: string[], from: number, end: number) => {
    for (let k = from; k < end; k++) if (to[k] !== '\n') to[k] = ' ';
  };
  while (i < text.length) {
    const c = text[i];
    if (open.length > exprDepth.length) {
      if (c === '\\') {
        blank(bare, i, i + 2);
        i += 2;
      } else if (c === '`') {
        templates.push({ start: open.pop() as number, end: i + 1 });
        i++;
      } else if (c === '$' && text[i + 1] === '{') {
        exprDepth.push(depth++);
        i += 2;
      } else {
        blank(bare, i, i + 1);
        i++;
      }
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '//' || two === '/*') {
      const close =
        two === '//' ? text.indexOf('\n', i) : text.indexOf('*/', i);
      const end = close < 0 ? text.length : close + (two === '/*' ? 2 : 0);
      blank(code, i, end);
      blank(bare, i, end);
      i = end;
      continue;
    }
    if (c === '/' && startsRegex(code, i)) {
      const end = regexEnd(text, i);
      if (end > 0) {
        blank(code, i + 1, end);
        blank(bare, i + 1, end);
        i = end;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const from = ++i;
      while (i < text.length && text[i] !== c && text[i] !== '\n') {
        i += text[i] === '\\' ? 2 : 1;
      }
      blank(bare, from, i);
    } else if (c === '`') open.push(i);
    else if (c === '{') depth++;
    else if (c === '}' && exprDepth.at(-1) === --depth) exprDepth.pop();
    i++;
  }
  return { code: code.join(''), bare: bare.join(''), templates };
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

/** One option value in a template: an interpolation or a bare word. */
const ARG = String.raw`(?:\$\{[^}]*\}|\S+)`;
/** Git options that may come before the subcommand, in any order. */
const GIT_GLOBALS = String.raw`(?:(?:-[cC]\s+${ARG}|--[\w-]+(?:=${ARG})?|\$\{[^}]*\})\s+)*`;

const PLUMBING = new RegExp(
  String.raw`^git\s+${GIT_GLOBALS}(?:rev-parse|rev-list|merge-base|merge-tree|diff|log|cat-file|show|ls-tree|reset)\b`
);
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

const GIT_PUSH = new RegExp(String.raw`^git\s+${GIT_GLOBALS}push\b`);
const Q = '[\'"`]';
/** An argv array whose first argument, after any git global options, is `push`. */
const ARGV_PUSH = new RegExp(
  String.raw`\[\s*(?:(?:${Q}-[cC]${Q}\s*,\s*[^,\]]+|${Q}--[\w-]+(?:=[^'"\`]*)?${Q})\s*,\s*)*${Q}push${Q}\s*[,\]]`,
  'g'
);

/** Rule 2: every `git push` runs as a netExec template (src/shared/net.ts). */
export const pushViaNet: Rule = ({ file, text }) => {
  const { code, templates } = scan(text);
  const found: Finding[] = [];
  for (const t of templates) {
    if (!GIT_PUSH.test(body(text, t))) continue;
    const tag = tagName(code, t.start);
    if (tag !== '' && tag !== 'netExec') {
      found.push({
        file,
        line: lineOf(text, t.start),
        message: `git push run through \`${tag}\`; use netExec from src/shared/net.ts`,
      });
    }
  }
  for (const m of code.matchAll(ARGV_PUSH)) {
    found.push({
      file,
      line: lineOf(text, m.index),
      message:
        'git push as an argv array bypasses netExec; push with a netExec template',
    });
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

/** The one module that runs `gh pr|issue create|edit`; it scans every upstream title and body. */
export const PUBLISH_HELPER = 'src/shared/upstream-publish.ts';

/**
 * Files that may run `gh pr|issue create|edit` outside {@link PUBLISH_HELPER},
 * each with the reason. Every entry must target the private mirror, never
 * upstream or the public fork.
 */
export const MIRROR_ONLY_GH: Readonly<Record<string, string>> = {
  'src/shared/sync-report.ts':
    'opens and edits the venfork-sync-blocked issue on the mirror itself',
};

const GH_PUBLISH =
  /^gh\s+(?:(?:-R|--repo)\s+(?:\$\{[^}]*\}|\S+)\s+)*(?:pr|issue)\s+(?:create|edit)\b/;
const GH_PUBLISH_ARGV =
  /['"`](?:pr|issue)['"`]\s*,\s*['"`](?:create|edit)['"`]/g;

/** Rule 4: only the publish helper creates or edits a PR or issue. */
export const denyListCoverage: Rule = ({ file, text }) => {
  if (file === PUBLISH_HELPER || file in MIRROR_ONLY_GH) return [];
  const { code, templates } = scan(text);
  const message = (what: string) =>
    `\`${what}\` outside ${PUBLISH_HELPER}; publish through its helpers so the title and body are scanned`;
  const found: Finding[] = templates
    .filter(
      (t) => tagName(code, t.start) !== '' && GH_PUBLISH.test(body(text, t))
    )
    .map((t) => ({
      file,
      line: lineOf(text, t.start),
      message: message(body(text, t).split(/\s+/).slice(0, 3).join(' ')),
    }));
  for (const m of code.matchAll(GH_PUBLISH_ARGV)) {
    found.push({ file, line: lineOf(text, m.index), message: message(m[0]) });
  }
  return found;
};

/** Rule 5: only src/index.ts ends the process. */
export const noProcessExit: Rule = ({ file, text }) => {
  if (!/^src\/(?:commands|shared)\//.test(file)) return [];
  const { bare } = scan(text);
  return [...bare.matchAll(/\bprocess\.exit\s*\(/g)].map((m) => ({
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

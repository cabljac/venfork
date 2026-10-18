import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/** Git subcommands that talk to a remote. */
const NET_SUBCOMMAND = String.raw`(push|fetch|ls-remote|clone|pull|remote\s+(?:set-head|update|show)|submodule\s+update(?=[^\n]*\s--remote\b)|archive(?=[^\n]*\s--remote\b))\b`;
const GIT_NET = new RegExp(String.raw`^git\s+${GIT_GLOBALS}${NET_SUBCOMMAND}`);
/** A git template whose subcommand is an interpolation, so its target cannot be told. */
const GIT_DYNAMIC = new RegExp(
  String.raw`^git\s+(?:(?:-[cC]\s+${ARG}|--[\w-]+(?:=${ARG})?)\s+)*\$\{[^}]*\}(?:\s+(?:\$\{[^}]*\}|[^-\s]\S*)|\s*$)`
);
/** Marks a dynamic git template, on the line before it, as local-only. */
export const LOCAL_GIT_MARKER = 'lint-invariants: local-git';

function markedLocal(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1);
  const before = text.slice(0, Math.max(lineStart, 0));
  const previous = before.slice(before.lastIndexOf('\n') + 1);
  const current = text.slice(lineStart + 1, start);
  return `${previous}\n${current}`.includes(LOCAL_GIT_MARKER);
}

/** gh subcommands that call GitHub. */
const GH_NET = /^gh\s+(api|repo\s+(?:clone|view))\b/;
const Q = '[\'"`]';
/** An argv array whose first argument, after any git global options, is a network subcommand. */
const ARGV_NET = new RegExp(
  String.raw`\[\s*(?:(?:${Q}-[cC]${Q}\s*,\s*[^,\]]+|${Q}--[\w-]+(?:=[^'"\`]*)?${Q})\s*,\s*)*${Q}(push|fetch|ls-remote)${Q}\s*[,\]]`,
  'g'
);

/**
 * Rule 2: every git network op, every git template whose subcommand is an
 * interpolation, and every `gh api` / `gh repo clone|view` runs as a
 * netExec template (src/shared/net.ts), which adds the fail-fast env, the
 * timeout and gh credentials.
 */
export const networkViaNet: Rule = ({ file, text }) => {
  const { code, templates } = scan(text);
  const found: Finding[] = [];
  for (const t of templates) {
    const raw = body(text, t);
    const match = GIT_NET.exec(raw) ?? GH_NET.exec(raw);
    const dynamic =
      !match && GIT_DYNAMIC.test(raw) && !markedLocal(text, t.start);
    if (!match && !dynamic) continue;
    const tag = tagName(code, t.start);
    if (tag === '' || tag === 'netExec') continue;
    const what = match
      ? `${raw.startsWith('gh') ? 'gh' : 'git'} ${match[1].replace(/\s+/g, ' ')}`
      : 'git with a dynamic subcommand';
    found.push({
      file,
      line: lineOf(text, t.start),
      message: `${what} run through \`${tag}\`; use netExec from src/shared/net.ts`,
    });
  }
  for (const m of code.matchAll(ARGV_NET)) {
    found.push({
      file,
      line: lineOf(text, m.index),
      message: `git ${m[1]} as an argv array bypasses netExec; run it as a netExec template`,
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

/** The one module that may ask the user anything. */
export const PROMPT_MODULE = 'src/shared/prompt.ts';

const CLACK_PROMPTS = [
  'text',
  'confirm',
  'select',
  'multiselect',
  'password',
  'groupMultiselect',
  'selectKey',
  'group',
];

const CLACK_IMPORT =
  /\bimport\s+(\*\s*as\s+[\w$]+|\{[^}]*\})\s*from\s*['"]@clack\/prompts['"]/g;

/** Rule 6: only {@link PROMPT_MODULE} calls the clack prompt functions. */
export const promptsViaModule: Rule = ({ file, text }) => {
  if (file === PROMPT_MODULE) return [];
  const { code, bare } = scan(text);
  const message = (name: string) =>
    `clack \`${name}\` outside ${PROMPT_MODULE}; ask through its helpers`;
  const found: Finding[] = [];
  for (const m of code.matchAll(CLACK_IMPORT)) {
    const clause = m[1];
    if (clause.startsWith('*')) {
      const ns = clause.replace(/^\*\s*as\s+/, '').replace(/\$/g, '\\$');
      const call = new RegExp(
        String.raw`(?<![\w$.])${ns}\s*\.\s*(${CLACK_PROMPTS.join('|')})\s*\(`,
        'g'
      );
      for (const c of bare.matchAll(call)) {
        found.push({
          file,
          line: lineOf(text, c.index),
          message: message(c[1]),
        });
      }
      continue;
    }
    for (const spec of clause.slice(1, -1).split(',')) {
      const name = spec.trim().split(/\s+as\s+/)[0];
      if (CLACK_PROMPTS.includes(name)) {
        found.push({
          file,
          line: lineOf(text, m.index),
          message: message(name),
        });
      }
    }
  }
  return found;
};

/** The module that owns human output; with {@link PROMPT_MODULE}, the only clack importers. */
export const UI_MODULE = 'src/shared/ui.ts';

const CLACK_SPECIFIER = /(?:\bfrom|\bimport\s*\(?)\s*['"]@clack\/prompts['"]/g;

/** Rule 7: only {@link UI_MODULE} and {@link PROMPT_MODULE} import `@clack/prompts`. */
export const clackViaUi: Rule = ({ file, text }) => {
  if (file === UI_MODULE || file === PROMPT_MODULE) return [];
  const { code } = scan(text);
  return [...code.matchAll(CLACK_SPECIFIER)].map((m) => ({
    file,
    line: lineOf(text, m.index),
    message: `@clack/prompts imported outside ${UI_MODULE} and ${PROMPT_MODULE}; use their helpers`,
  }));
};

const EM_DASH = '\u2014';

/** Rule 8: no em dash (U+2014) in code, tests or docs. */
export const noEmDash: Rule = ({ file, text }) =>
  text.split('\n').flatMap((line, i) =>
    line.includes(EM_DASH)
      ? [
          {
            file,
            line: i + 1,
            message: 'em dash (U+2014); use "-" or reword',
          },
        ]
      : []
  );

/** Repo-relative files and directories the text rules read, every file in them. */
export const TEXT_ROOTS = ['src', 'tests', 'docs', 'README.md'];

/** Rules over every file under {@link TEXT_ROOTS}, not only src TypeScript. */
export const textRules: Record<string, Rule> = {
  'no-em-dash': noEmDash,
};

/** Every invariant rule, keyed by the name printed in findings. */
export const rules: Record<string, Rule> = {
  'remote-refs': remoteRefs,
  'network-via-net': networkViaNet,
  'import-boundary': importBoundary,
  'deny-list-coverage': denyListCoverage,
  'no-process-exit': noProcessExit,
  'prompts-via-module': promptsViaModule,
  'clack-via-ui': clackViaUi,
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

/** Runs every text rule over the given sources. */
export function lintText(sources: Source[]): Array<Finding & { rule: string }> {
  return sources.flatMap((src) =>
    Object.entries(textRules).flatMap(([rule, check]) =>
      check(src).map((f) => ({ ...f, rule }))
    )
  );
}

/** Every file under {@link TEXT_ROOTS}, as repo-relative POSIX paths. */
export function textFiles(root: string): string[] {
  const walk = (rel: string): string[] =>
    statSync(path.join(root, rel)).isDirectory()
      ? readdirSync(path.join(root, rel)).flatMap((name) =>
          walk(path.posix.join(rel, name))
        )
      : [rel];
  return TEXT_ROOTS.flatMap(walk);
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
  const texts = textFiles(root).map((file) => ({
    file,
    text: readFileSync(path.join(root, file), 'utf8'),
  }));
  const findings = [...lintSources(sources), ...lintText(texts)];
  for (const f of findings) {
    console.error(`${f.file}:${f.line}  [${f.rule}] ${f.message}`);
  }
  if (findings.length > 0) {
    console.error(`\n${findings.length} invariant violation(s).`);
    process.exit(1);
  }
  console.log(
    `Invariants hold across ${sources.length} source and ${texts.length} text files.`
  );
}

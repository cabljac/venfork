/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures are TypeScript source held in strings */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  clackViaUi,
  denyListCoverage,
  importBoundary,
  LOCAL_GIT_MARKER,
  networkViaNet,
  noEmDash,
  noProcessExit,
  PROMPT_MODULE,
  PUBLISH_HELPER,
  promptsViaModule,
  remoteRefs,
  textFiles,
  UI_MODULE,
} from '../../scripts/lint-invariants';

const src = (file: string, text: string) => ({ file, text });

describe('scan', () => {
  test('a regex literal holding // does not hide the rest of the line', () => {
    const text =
      "const b = s.replace(/^refs\\/heads\\//, ''); await $`git push origin ${b}`;";
    expect(networkViaNet(src('src/commands/x.ts', text))).toHaveLength(1);
  });

  test('process.exit inside a string or template is not code', () => {
    const text = [
      "const hint = 'never call process.exit(1) here';",
      'const doc = `process.exit(${code}) ends the run`;',
    ].join('\n');
    expect(noProcessExit(src('src/commands/x.ts', text))).toEqual([]);
  });
});

describe('remoteRefs', () => {
  test('flags a short remote ref inside a nested plumbing argument', () => {
    const text = [
      'const a = 1;',
      'await $`git rev-list ${`upstream/${branch}..HEAD`}`;',
    ].join('\n');
    const found = remoteRefs(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([2]);
  });

  test('flags short refs after global options and in more plumbing', () => {
    const text = [
      'await $`git --literal-pathspecs ls-tree -z origin/${b}`;',
      'await $`git -C ${dir} rev-parse origin/${b}`;',
      'await $`git --no-pager -c core.quotepath=off log upstream/${b}`;',
      'await $`git -c a=b -C ${dir} merge-tree upstream/${b} HEAD`;',
      'await $`git reset --hard origin/${b}`;',
      'await $`git cat-file -p public/${b}`;',
    ].join('\n');
    const found = remoteRefs(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('allows full refs and short refs in messages', () => {
    const text = [
      'await $`git merge-base ${`refs/remotes/upstream/${b}`} HEAD`;',
      'await $`git -C ${dir} ls-tree refs/remotes/origin/${b}`;',
      'await resolveCommit(`refs/remotes/origin/${b}`, cwd);',
      'throw new Error(`upstream/${b} not found`);',
    ].join('\n');
    expect(remoteRefs(src('src/commands/x.ts', text))).toEqual([]);
  });
});

describe('networkViaNet', () => {
  test('flags git push run through a raw execa $', () => {
    const text = 'await $({ cwd, reject: false })`git push origin ${b}`;';
    const found = networkViaNet(src('src/commands/x.ts', text));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('`$`');
  });

  test('flags pushes behind global options and as argv arrays', () => {
    const text = [
      'await $`git -C ${dir} push origin x`;',
      'await $`git --no-pager push origin x`;',
      "await execa('git', ['push', 'origin', b]);",
      "await execa('git', ['-C', dir, '--no-pager', 'push']);",
      "await execa('git', [`push`, 'origin']);",
    ].join('\n');
    const found = networkViaNet(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5]);
  });

  test('flags fetch, ls-remote, clone, pull and remote set-head outside netExec', () => {
    const text = [
      'await $({ cwd })`git fetch upstream ${spec}`;',
      'await $`git ls-remote --exit-code origin x`;',
      'await $`git clone ${url} ${dir}`;',
      'await $`git -C ${dir} pull`;',
      'await $`git remote set-head origin -a`;',
      "await execa('git', ['fetch', 'origin']);",
      "await execa('git', ['ls-remote', url]);",
    ].join('\n');
    const found = networkViaNet(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(found[0].message).toContain('git fetch run through `$`');
  });

  test('flags remote update and show, submodule update --remote and archive --remote', () => {
    const text = [
      'await $`git remote update`;',
      'await $({ cwd })`git remote show origin`;',
      'await $`git submodule update --init --remote`;',
      'await $`git archive --remote=${url} HEAD`;',
    ].join('\n');
    const found = networkViaNet(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4]);
  });

  test('flags a git template whose subcommand is only an interpolation', () => {
    const text = [
      'await $({ cwd })`git ${args}`;',
      'await $`git -C ${dir} ${sub} origin`;',
    ].join('\n');
    const found = networkViaNet(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2]);
    expect(found[0].message).toContain('dynamic');
  });

  test('allows a dynamic git template marked local-only on the line before', () => {
    const text = [
      '  const run = await $({',
      '    cwd,',
      `    // ${LOCAL_GIT_MARKER}: plumbing only`,
      '  })`git -c core.hooksPath=${hooks} ${args}`;',
    ].join('\n');
    expect(networkViaNet(src('src/shared/x.ts', text))).toEqual([]);
  });

  test('flags gh network calls (api, repo clone, repo view) outside netExec', () => {
    const text = [
      'await $`gh api user --jq .login`;',
      'await $({ reject: false })`gh repo view ${name}`;',
      'await $`gh repo clone ${repo} ${dir}`;',
    ].join('\n');
    const found = networkViaNet(src('src/git.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2, 3]);
    expect(found[0].message).toContain('gh api run through `$`');
  });

  test('allows local submodule and archive commands and local gh calls', () => {
    const text = [
      'await $`git submodule update --init`;',
      'await $`git archive HEAD`;',
      'await $`gh config get git_protocol --host github.com`;',
      'await netExec(cwd, { bufferOutput: true })`gh api ${path}`;',
    ].join('\n');
    expect(networkViaNet(src('src/commands/x.ts', text))).toEqual([]);
  });

  test('allows local remote subcommands and gh clone through netExec', () => {
    const text = [
      'await $`git remote get-url origin`;',
      'await $`git remote set-url --push upstream DISABLE`;',
      'await netExec(cwd)`git fetch ${remote}`;',
      'await netExec()`gh repo clone ${repo} ${dir}`;',
    ].join('\n');
    expect(networkViaNet(src('src/commands/x.ts', text))).toEqual([]);
  });

  test('allows netExec pushes, push messages and comments', () => {
    const text = [
      '// `git push` here would be fine in a comment',
      'await netExec(cwd, { bufferOutput: true })`git ${cfg} push origin x`;',
      'await netExec(cwd)`git -C ${dir} push origin x`;',
      'throw new GitError(`git push ${b} failed`, "git push");',
    ].join('\n');
    expect(networkViaNet(src('src/config.ts', text))).toEqual([]);
  });

  test('ignores the push method and push as a plain value', () => {
    const text = [
      "args.push('push');",
      "type Op = 'push' | 'fetch';",
      "if (mode === 'push') run();",
      "// ['push'] in a comment",
    ].join('\n');
    expect(networkViaNet(src('src/commands/x.ts', text))).toEqual([]);
  });
});

describe('importBoundary', () => {
  test('flags a command importing another command', () => {
    const text = "import { syncCommand } from './sync.js';";
    const found = importBoundary(src('src/commands/setup.ts', text));
    expect(found.map((f) => f.message)).toEqual([
      'a command imports src/commands/sync.js; move the shared code to src/shared/',
    ]);
  });

  test('allows commands to import shared and top-level modules', () => {
    const text = [
      "import { netExec } from '../shared/net.js';",
      "import { GitError } from '../errors.js';",
      "import { $ } from 'execa';",
    ].join('\n');
    expect(importBoundary(src('src/commands/stage.ts', text))).toEqual([]);
  });
});

describe('denyListCoverage', () => {
  test('flags gh pr create outside the publish helper, even next to a scan', () => {
    const text = [
      "import { assertNoMirrorReference } from '../shared/deny-list.js';",
      "assertNoMirrorReference(body, 'the body', denyList);",
      'await $({ input: body })`gh pr create --repo ${r} --title ${t} --body-file -`;',
    ].join('\n');
    const found = denyListCoverage(src('src/commands/stage.ts', text));
    expect(found.map((f) => f.line)).toEqual([3]);
  });

  test('flags gh issue create after --repo and the argv form, not messages', () => {
    const text = [
      'await $`gh --repo ${r} issue create --title ${t} --body-file -`;',
      "await gh(cwd, ['pr', 'edit', url, '--body-file', '-'], body);",
      'p.log.warn(`gh pr edit exit ${code}`);',
    ].join('\n');
    const found = denyListCoverage(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2]);
  });

  test('allows the raw calls in the publish helper and mirror-only files', () => {
    const template =
      'await $({ input: body })`gh issue edit ${n} --body-file -`;';
    const argv = "await gh(cwd, ['issue', 'create', '--repo', repo], body);";
    expect(denyListCoverage(src(PUBLISH_HELPER, template))).toEqual([]);
    expect(denyListCoverage(src('src/shared/sync-report.ts', argv))).toEqual(
      []
    );
  });
});

describe('noProcessExit', () => {
  test('flags process.exit in src/shared', () => {
    const text = 'if (bad) process.exit(1);';
    expect(noProcessExit(src('src/shared/x.ts', text))).toHaveLength(1);
  });

  test('allows process.exit in src/index.ts and in comments', () => {
    expect(noProcessExit(src('src/index.ts', 'process.exit(1);'))).toEqual([]);
    const comment = '// never call process.exit(1) here';
    expect(noProcessExit(src('src/commands/x.ts', comment))).toEqual([]);
  });
});

describe('promptsViaModule', () => {
  test('flags prompt calls and named prompt imports outside the prompt module', () => {
    const text = [
      "import * as p from '@clack/prompts';",
      "import { confirm as ask, log } from '@clack/prompts';",
      "const name = await p.text({ message: 'Name?' });",
      "const ok = await p .confirm({ message: 'Go?' });",
      "await p.select({ message: 'Pick', options: [] });",
    ].join('\n');
    const found = promptsViaModule(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line).sort()).toEqual([2, 3, 4, 5]);
  });

  test('allows the prompt module, other clack calls, comments and strings', () => {
    const call = [
      "import * as p from '@clack/prompts';",
      'await p.text({ message });',
    ].join('\n');
    expect(promptsViaModule(src(PROMPT_MODULE, call))).toEqual([]);
    const text = [
      "import * as p from '@clack/prompts';",
      "p.log.info('run p.confirm( later');",
      '// p.text({ message })',
      'if (p.isCancel(v)) p.cancel();',
      'other.text({ message });',
    ].join('\n');
    expect(promptsViaModule(src('src/commands/x.ts', text))).toEqual([]);
  });
});

describe('clackViaUi', () => {
  test('flags every form of @clack/prompts import outside ui and prompt', () => {
    const text = [
      "import * as p from '@clack/prompts';",
      "import { log } from '@clack/prompts';",
      "import type { SpinnerResult } from '@clack/prompts';",
      "export { note } from '@clack/prompts';",
      "const c = await import('@clack/prompts');",
      "import '@clack/prompts';",
    ].join('\n');
    const found = clackViaUi(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('allows the ui and prompt modules, comments and other packages', () => {
    const text = "import * as p from '@clack/prompts';";
    expect(clackViaUi(src(UI_MODULE, text))).toEqual([]);
    expect(clackViaUi(src(PROMPT_MODULE, text))).toEqual([]);
    const other = [
      "// import * as p from '@clack/prompts';",
      "import * as core from '@clack/core';",
      "import * as p from '../shared/ui.js';",
    ].join('\n');
    expect(clackViaUi(src('src/commands/x.ts', other))).toEqual([]);
  });
});

describe('noEmDash', () => {
  test('flags each line that holds an em dash, in any file', () => {
    const text = ['one - fine', 'two \u2014 not', 'three'].join('\n');
    expect(noEmDash(src('docs/reference/x.md', text))).toEqual([
      {
        file: 'docs/reference/x.md',
        line: 2,
        message: 'em dash (U+2014); use "-" or reword',
      },
    ]);
  });

  test('reads src, tests, the README and docs', () => {
    const files = textFiles(path.resolve(import.meta.dir, '../..'));
    expect(files).toContain('README.md');
    expect(files).toContain('docs/reference/commands.md');
    expect(files).toContain('src/index.ts');
    expect(files).toContain('tests/unit/lint-invariants.test.ts');
    expect(files).not.toContain('CHANGELOG.md');
  });
});

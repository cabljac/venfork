/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures are TypeScript source held in strings */
import { describe, expect, test } from 'bun:test';
import {
  denyListCoverage,
  importBoundary,
  noProcessExit,
  PUBLISH_HELPER,
  pushViaNet,
  remoteRefs,
} from '../../scripts/lint-invariants';

const src = (file: string, text: string) => ({ file, text });

describe('scan', () => {
  test('a regex literal holding // does not hide the rest of the line', () => {
    const text =
      "const b = s.replace(/^refs\\/heads\\//, ''); await $`git push origin ${b}`;";
    expect(pushViaNet(src('src/commands/x.ts', text))).toHaveLength(1);
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

describe('pushViaNet', () => {
  test('flags git push run through a raw execa $', () => {
    const text = 'await $({ cwd, reject: false })`git push origin ${b}`;';
    const found = pushViaNet(src('src/commands/x.ts', text));
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
    const found = pushViaNet(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5]);
  });

  test('allows netExec pushes, push messages and comments', () => {
    const text = [
      '// `git push` here would be fine in a comment',
      'await netExec(cwd, { bufferOutput: true })`git ${cfg} push origin x`;',
      'await netExec(cwd)`git -C ${dir} push origin x`;',
      'throw new GitError(`git push ${b} failed`, "git push");',
    ].join('\n');
    expect(pushViaNet(src('src/config.ts', text))).toEqual([]);
  });

  test('ignores the push method and push as a plain value', () => {
    const text = [
      "args.push('push');",
      "type Op = 'push' | 'fetch';",
      "if (mode === 'push') run();",
      "// ['push'] in a comment",
    ].join('\n');
    expect(pushViaNet(src('src/commands/x.ts', text))).toEqual([]);
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

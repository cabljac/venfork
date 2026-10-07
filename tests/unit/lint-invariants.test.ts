/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures are TypeScript source held in strings */
import { describe, expect, test } from 'bun:test';
import {
  denyListCoverage,
  importBoundary,
  noProcessExit,
  pushViaNet,
  remoteRefs,
} from '../../scripts/lint-invariants';

const src = (file: string, text: string) => ({ file, text });

describe('remoteRefs', () => {
  test('flags a short remote ref inside a nested plumbing argument', () => {
    const text = [
      'const a = 1;',
      'await $`git rev-list ${`upstream/${branch}..HEAD`}`;',
    ].join('\n');
    const found = remoteRefs(src('src/commands/x.ts', text));
    expect(found.map((f) => f.line)).toEqual([2]);
  });

  test('allows full refs and short refs in messages', () => {
    const text = [
      'await $`git merge-base ${`refs/remotes/upstream/${b}`} HEAD`;',
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

  test('allows netExec pushes, push messages and comments', () => {
    const text = [
      '// `git push` here would be fine in a comment',
      'await netExec(cwd, { bufferOutput: true })`git ${cfg} push origin x`;',
      'throw new GitError(`git push ${b} failed`, "git push");',
    ].join('\n');
    expect(pushViaNet(src('src/config.ts', text))).toEqual([]);
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
  test('flags gh pr create in a file without assertNoMirrorReference', () => {
    const text =
      'await $({ input: body })`gh pr create --repo ${r} --title ${t} --body-file -`;';
    expect(denyListCoverage(src('src/commands/x.ts', text))).toHaveLength(1);
  });

  test('allows gh issue edit when the file imports and calls the scan', () => {
    const text = [
      "import { assertNoMirrorReference } from '../shared/deny-list.js';",
      "assertNoMirrorReference(body, 'the body', denyList);",
      'await $({ input: body })`gh issue edit ${n} --body-file -`;',
    ].join('\n');
    expect(denyListCoverage(src('src/commands/x.ts', text))).toEqual([]);
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

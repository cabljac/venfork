import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];

mock.module('execa', () => ({
  $:
    () =>
    (strings: TemplateStringsArray, ...vals: unknown[]) => {
      calls.push(
        String.raw(
          { raw: strings },
          ...vals.map((v) => (Array.isArray(v) ? v.join(' ') : String(v)))
        )
      );
      return Promise.resolve({
        exitCode: 0,
        stdout: 'https://github.com/up/proj/issues/7',
        stderr: '',
      });
    },
}));

import { MirrorReferenceError } from '../../src/errors.js';
import {
  createUpstreamIssue,
  createUpstreamPr,
  editUpstreamPrBody,
} from '../../src/shared/upstream-publish.js';

const denyList = ['acme/widget-private'];
const leak = 'see acme/widget-private#3';
const pr = {
  upstreamRepoPath: 'up/proj',
  headOwner: 'acme',
  sameRepoHead: false,
  branch: 'feat',
  base: 'main',
  title: 'Add feature',
  body: 'Adds the feature.',
  draft: false,
  denyList,
  cwd: '.',
};
const issue = {
  repoPath: 'up/proj',
  title: 'A bug',
  body: 'Steps.',
  denyList,
  cwd: '.',
};

beforeEach(() => {
  calls.length = 0;
});

describe('the publish helpers scan before gh runs', () => {
  test('createUpstreamPr refuses a mirror reference in the title', async () => {
    await expect(createUpstreamPr({ ...pr, title: leak })).rejects.toThrow(
      MirrorReferenceError
    );
    expect(calls).toEqual([]);
  });

  test('createUpstreamPr refuses a mirror reference in the body', async () => {
    await expect(createUpstreamPr({ ...pr, body: leak })).rejects.toThrow(
      MirrorReferenceError
    );
    expect(calls).toEqual([]);
  });

  test('editUpstreamPrBody refuses a mirror reference in the body', async () => {
    await expect(
      editUpstreamPrBody({
        prUrl: 'https://github.com/up/proj/pull/1',
        body: leak,
        denyList,
        cwd: '.',
      })
    ).rejects.toThrow(MirrorReferenceError);
    expect(calls).toEqual([]);
  });

  test('createUpstreamIssue refuses a mirror reference in the title or body', async () => {
    await expect(
      createUpstreamIssue({ ...issue, title: leak })
    ).rejects.toThrow(MirrorReferenceError);
    await expect(createUpstreamIssue({ ...issue, body: leak })).rejects.toThrow(
      MirrorReferenceError
    );
    expect(calls).toEqual([]);
  });

  test('clean text reaches gh once', async () => {
    await expect(createUpstreamIssue(issue)).resolves.toEqual({
      url: 'https://github.com/up/proj/issues/7',
      number: 7,
    });
    expect(calls).toEqual([
      'gh issue create --repo up/proj --title A bug --body-file -',
    ]);
  });
});

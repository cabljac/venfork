import { describe, expect, test } from 'bun:test';
import { parseStageCliArgs } from '../src/stage-args.js';

describe('parseStageCliArgs', () => {
  test('parses branch-only invocation', () => {
    expect(parseStageCliArgs(['feature/x'])).toEqual({
      branch: 'feature/x',
      createPr: false,
      copyPrBody: false,
    });
  });

  test('parses create-pr and copy-pr-body flags', () => {
    expect(
      parseStageCliArgs(['feature/x', '--create-pr', '--copy-pr-body'])
    ).toEqual({
      branch: 'feature/x',
      createPr: true,
      copyPrBody: true,
    });
  });

  test('throws when copy-pr-body used without create-pr', () => {
    expect(() => parseStageCliArgs(['feature/x', '--copy-pr-body'])).toThrow(
      '--copy-pr-body requires --create-pr'
    );
  });
});

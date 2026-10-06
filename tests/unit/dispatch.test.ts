import { describe, expect, test } from 'bun:test';
import { requiresGhAuth } from '../../src/dispatch.js';

describe('requiresGhAuth', () => {
  test.each([
    ['setup', ['acme/widget'], true],
    ['clone', ['acme/widget-private'], true],
    ['pull', ['pr', '12'], true],
    ['pull', ['issue', '3'], true],
    ['pull', ['--no-push', 'pr', '5'], true],
    ['pull', [], false],
    ['pull', ['pr'], false],
    ['pull', ['issue'], false],
    ['pull', ['pr', '5', '--bogus'], false],
    ['pull', ['nope', '5'], false],
    ['stage', ['issue', '3'], true],
    ['stage', ['branch', 'feature'], false],
    ['stage', ['branch', 'feature', '--pr'], true],
    ['stage', ['issue'], false],
    ['stage', ['feature'], false],
    ['stage', ['feature', '--pr'], true],
    ['stage', ['feature', '--draft'], true],
    ['stage', ['feature', '--title', 'x', '--base', 'main'], false],
    ['sync', [], false],
    ['schedule', ['set', '0 * * * *'], false],
    ['workflows', ['status'], false],
    ['preserve', ['list'], false],
    ['doctor', [], false],
    ['help', [], false],
  ] as const)('%s %p -> %p', (command, args, expected) => {
    expect(requiresGhAuth(command, [...args])).toBe(expected);
  });
});

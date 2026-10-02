import { describe, expect, test } from 'bun:test';
import { requiresGhAuth } from '../../src/dispatch.js';

describe('requiresGhAuth', () => {
  test.each([
    ['setup', ['acme/widget'], true],
    ['clone', ['acme/widget-private'], true],
    ['pull-request', ['12'], true],
    ['issue', ['stage', '3'], true],
    ['stage', ['feature'], false],
    ['stage', ['feature', '--pr'], true],
    ['stage', ['feature', '--draft'], true],
    ['stage', ['feature', '--title', 'x', '--base', 'main'], false],
    ['sync', [], false],
    ['schedule', ['set', '0 * * * *'], false],
    ['status', [], false],
    ['workflows', ['status'], false],
    ['preserve', ['list'], false],
    ['doctor', [], false],
    ['help', [], false],
  ] as const)('%s %p -> %p', (command, args, expected) => {
    expect(requiresGhAuth(command, [...args])).toBe(expected);
  });
});

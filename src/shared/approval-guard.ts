import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'execa';
import { APPROVAL_LEVELS, type ApprovalLevel } from '../config.js';

/** A lowered approval level that a person must confirm before stage goes on. */
export interface Weakening {
  /** The level this clone last saw. */
  from: string;
  /** The mirror's level now. */
  to: ApprovalLevel;
  /** True when the clone memory could not be read, so `from` is `two-person`. */
  unreadable?: true;
}

/** What the clone memory holds: the last level a stage or setup in this clone saw. */
interface ApprovalMemory {
  level: string;
}

/** Rank of a stored level; a level this version does not know ranks above all. */
export function approvalRank(level: string | undefined): number {
  const index = APPROVAL_LEVELS.indexOf((level ?? 'off') as ApprovalLevel);
  return index === -1 ? APPROVAL_LEVELS.length : index;
}

/**
 * Path of the clone memory, `<git common dir>/venfork/approval.json`.
 * Linked worktrees share it; git never pushes it.
 */
export async function approvalMemoryPath(repoDir: string): Promise<string> {
  const dir = (
    await $({ cwd: repoDir })`git rev-parse --git-common-dir`
  ).stdout.trim();
  return path.resolve(repoDir, dir, 'venfork', 'approval.json');
}

type MemoryRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; memory: ApprovalMemory };

async function readMemory(file: string): Promise<MemoryRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    return { kind: 'unreadable' };
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (
      raw &&
      typeof raw === 'object' &&
      'level' in raw &&
      typeof raw.level === 'string'
    ) {
      return { kind: 'ok', memory: { level: raw.level } };
    }
  } catch {}
  return { kind: 'unreadable' };
}

/**
 * Records `level` as the last approval level this clone saw. Writes
 * `{ "level": "<level>" }` to {@link approvalMemoryPath}, replacing a
 * corrupt file. Call it after a person confirmed a lowered level, or when
 * the level is equal to or higher than the one remembered.
 */
export async function rememberApproval(
  repoDir: string,
  level: ApprovalLevel
): Promise<void> {
  const file = await approvalMemoryPath(repoDir);
  const read = await readMemory(file);
  if (read.kind === 'ok' && read.memory.level === level) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ level }, null, 2)}\n`);
}

/**
 * The lowering to confirm when the mirror's level `current` ranks below
 * the level this clone remembers, else null. A missing memory (a fresh
 * clone) is null; a memory that cannot be read counts as `two-person`.
 * A convenience only: a fresh clone does not know an earlier level.
 */
export async function findWeakening(
  current: ApprovalLevel,
  repoDir: string
): Promise<Weakening | null> {
  const read = await readMemory(await approvalMemoryPath(repoDir));
  if (read.kind === 'missing') return null;
  const from = read.kind === 'ok' ? read.memory.level : 'two-person';
  if (approvalRank(current) >= approvalRank(from)) return null;
  return read.kind === 'unreadable'
    ? { from, to: current, unreadable: true }
    : { from, to: current };
}

/** One line for the refusal and the confirm. */
export function describeWeakening(w: Weakening): string {
  return w.unreadable
    ? `approval is ${w.to}, and this clone's approval memory cannot be read, so venfork treats it as two-person`
    : `approval is ${w.to}, but this clone last saw ${w.from}`;
}

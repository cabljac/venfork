import {
  type ApprovalLevel,
  applyPatchAndNormalize,
  approvalOf,
  configNotFoundError,
  readVenforkConfigFromRepoWithSha,
  writeVenforkConfigAt,
} from '../config.js';
import { CommandExitError } from '../errors.js';
import {
  APPROVAL_OFF_WARNING,
  approvalRank,
  findWeakening,
  rememberApproval,
} from '../shared/approval-guard.js';
import {
  canPrompt,
  DEFAULT_PROMPT_CONTEXT,
  isCancel,
  type PromptContext,
  promptConfirm,
} from '../shared/prompt.js';
import * as p from '../shared/ui.js';

/** The approval level after `venfork stage approval`, reported as the `--json` result. */
export interface ApprovalResult {
  level: ApprovalLevel;
}

const MEANING: Record<ApprovalLevel, string> = {
  off: 'venfork stage publishes a branch without a review on its mirror PR.',
  reviewed:
    'venfork stage needs an approving review on the mirror PR head from a person with write access who is not the PR author, and passing checks.',
  'two-person':
    'venfork stage needs an approving review on the mirror PR head from a person with write access who is not the PR author and not the person running stage, and passing checks.',
};

/**
 * `venfork stage approval [level]`: prints the mirror's approval level, or
 * sets it in venfork-config. Turning the gate off prints a warning.
 * Lowering the level asks a person at a terminal (`--yes` never answers);
 * without one the level is still written and the next stage in this clone
 * asks instead. The write is refused when venfork-config moved during the
 * confirm, so the confirmed lowering is the one written.
 * @returns The level after the action, for `--json`.
 */
export async function approvalCommand(
  level?: ApprovalLevel,
  prompt: PromptContext = DEFAULT_PROMPT_CONTEXT
): Promise<ApprovalResult> {
  p.intro('🛂 Venfork Stage Approval');
  const repoDir = process.cwd();
  try {
    const read = await readVenforkConfigFromRepoWithSha(repoDir);
    if (!read) throw configNotFoundError();
    const current = approvalOf(read.config);
    if (level === undefined) {
      p.note(`${current}: ${MEANING[current]}`, 'Approval');
      if (current === 'off') p.log.warn(APPROVAL_OFF_WARNING);
      p.outro('✨ Approval level shown');
      return { level: current };
    }
    const lowering = approvalRank(level) < approvalRank(current);
    const confirmed =
      lowering && (await confirmLowering(current, level, prompt));
    await writeVenforkConfigAt(
      repoDir,
      applyPatchAndNormalize(read.config, { approval: level }),
      read.sha
    );
    const seen = lowering && !confirmed ? current : level;
    if (confirmed || !(await findWeakening(seen, repoDir))) {
      await rememberApproval(repoDir, seen);
    }
    if (lowering && !confirmed) {
      p.log.warn(
        'No one confirmed this at a terminal, so the next venfork stage in this clone asks a person to confirm the lower level.'
      );
    }
    p.note(`${level}: ${MEANING[level]}`, 'Approval');
    if (level === 'off') p.log.warn(APPROVAL_OFF_WARNING);
    p.outro(`✨ Approval set to ${level}`);
    return { level };
  } catch (error) {
    throw p.reportFailure(error);
  }
}

/**
 * Asks a person at a terminal to confirm lowering the level; `--yes` never
 * answers it. Returns false without a terminal.
 */
async function confirmLowering(
  from: ApprovalLevel,
  level: ApprovalLevel,
  prompt: PromptContext
): Promise<boolean> {
  if (!canPrompt(prompt)) return false;
  const answer = await promptConfirm(
    {
      message: `Lower approval from ${from} to ${level}?`,
      initialValue: false,
    },
    { yes: false, noInput: prompt.noInput }
  );
  if (isCancel(answer)) {
    p.cancel('Operation cancelled');
    throw new CommandExitError(130);
  }
  if (!answer) {
    p.outro('Approval unchanged');
    throw new CommandExitError(0);
  }
  return true;
}

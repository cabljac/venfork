import {
  type ApprovalLevel,
  approvalOf,
  configNotFoundError,
  readVenforkConfigFromRepo,
  updateVenforkConfig,
} from '../config.js';
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

/** The warning printed whenever the gate is turned off. */
export const APPROVAL_OFF_WARNING =
  'The approval gate is off: venfork stage can publish any branch, from any person or agent with access to this clone, without a review. Turn it back on with `venfork stage approval on`.';

/**
 * `venfork stage approval [level]`: prints the mirror's approval level, or
 * sets it in venfork-config. Turning the gate off prints a warning.
 * @returns The level after the action, for `--json`.
 */
export async function approvalCommand(
  level?: ApprovalLevel
): Promise<ApprovalResult> {
  p.intro('🛂 Venfork Stage Approval');
  const repoDir = process.cwd();
  try {
    if (level === undefined) {
      const config = await readVenforkConfigFromRepo(repoDir);
      if (!config) throw configNotFoundError();
      const current = approvalOf(config);
      p.note(`${current}: ${MEANING[current]}`, 'Approval');
      if (current === 'off') p.log.warn(APPROVAL_OFF_WARNING);
      p.outro('✨ Approval level shown');
      return { level: current };
    }
    const updated = await updateVenforkConfig(repoDir, { approval: level });
    const now = approvalOf(updated);
    p.note(`${now}: ${MEANING[now]}`, 'Approval');
    if (now === 'off') p.log.warn(APPROVAL_OFF_WARNING);
    p.outro(`✨ Approval set to ${now}`);
    return { level: now };
  } catch (error) {
    throw p.reportFailure(error);
  }
}

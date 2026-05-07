/**
 * Venfork public library API.
 *
 * Downstream tools (bots, CI scripts, triage automation) should use
 * these exports to read venfork config instead of fetching the
 * `venfork-config` branch directly.  Both helpers handle the
 * force-push semantics of the config branch internally: they never
 * update a local ref, so they are safe to call from a long-lived
 * clone without ever hitting a non-fast-forward rejection.
 */
export {
  fetchVenforkConfig,
  readVenforkConfigFromRepo,
} from './config.js';

export type {
  PulledIssue,
  PulledPr,
  ShippedBranch,
  ShippedIssue,
  VenforkConfig,
  VenforkConfigPatch,
} from './config.js';

import * as p from '@clack/prompts';
import { readVenforkConfigFromRepo, type VenforkConfig } from '../config.js';
import { ConfigError, NotInRepositoryError } from '../errors.js';
import {
  getCurrentBranch,
  getRemotes,
  hasRemote,
  isGitRepository,
} from '../git.js';

/**
 * Status command: Show current repository setup and configuration
 */
export async function statusCommand(): Promise<void> {
  p.intro('📊 Venfork Status');

  // Check if we're in a git repository
  const inGitRepo = await isGitRepository();
  if (!inGitRepo) {
    throw new NotInRepositoryError();
  }

  // Get current branch
  const currentBranch = await getCurrentBranch();

  // Get remotes
  const remotes = await getRemotes();
  const hasOrigin = await hasRemote('origin');
  const hasPublic = await hasRemote('public');
  const hasUpstream = await hasRemote('upstream');

  let config: VenforkConfig | null = null;
  try {
    config = await readVenforkConfigFromRepo(process.cwd());
  } catch (err) {
    if (err instanceof ConfigError) {
      p.log.warn(`Could not read venfork-config: ${err.message}`);
    }
  }
  const mode: 'standard' | 'no-public' =
    config?.mode === 'no-public' ? 'no-public' : 'standard';
  const noPublic = mode === 'no-public';

  // Check if setup is complete
  const isSetupComplete = hasOrigin && hasUpstream && (noPublic || hasPublic);

  // Display git remotes
  if (Object.keys(remotes).length > 0) {
    const remotesText = Object.entries(remotes)
      .map(([name, urls]) => {
        const fetchUrl = urls.fetch || '(not set)';
        const pushUrl = urls.push || '(not set)';
        return `${name}:\n  fetch: ${fetchUrl}\n  push:  ${pushUrl}`;
      })
      .join('\n\n');

    p.note(remotesText, 'Git Remotes');
  } else {
    p.note('No remotes configured', 'Git Remotes');
  }

  // Display status
  const statusLines = [
    `Current branch: ${currentBranch || '(detached HEAD)'}`,
    `Mode: ${mode}`,
    '',
    'Setup status:',
    `  ${hasOrigin ? '✓' : '✗'} origin (private mirror)`,
  ];
  if (!noPublic) {
    statusLines.push(`  ${hasPublic ? '✓' : '✗'} public (public fork)`);
  }
  statusLines.push(`  ${hasUpstream ? '✓' : '✗'} upstream (original repo)`);

  p.note(statusLines.join('\n'), 'Repository Status');

  if (isSetupComplete && config) {
    const linkageBlocks: string[] = [];

    const formatDate = (iso: string): string => {
      try {
        return new Date(iso).toISOString().slice(0, 10);
      } catch {
        return iso;
      }
    };

    const ship = config.shippedBranches ?? {};
    if (Object.keys(ship).length > 0) {
      const lines = Object.entries(ship)
        .map(
          ([branch, entry]) =>
            `  ${branch} → ${entry.upstreamPrUrl} (${formatDate(entry.shippedAt)})`
        )
        .join('\n');
      linkageBlocks.push(`Shipped branches:\n${lines}`);
    }

    const pulled = config.pulledPrs ?? {};
    if (Object.keys(pulled).length > 0) {
      const lines = Object.entries(pulled)
        .map(
          ([branch, entry]) =>
            `  ${branch} → ${entry.upstreamPrUrl} (last sync ${formatDate(entry.lastSyncedAt)})`
        )
        .join('\n');
      linkageBlocks.push(`Pulled PRs:\n${lines}`);
    }

    const shippedIssues = config.shippedIssues ?? {};
    if (Object.keys(shippedIssues).length > 0) {
      const lines = Object.entries(shippedIssues)
        .map(
          ([, entry]) =>
            `  #${entry.internalIssueNumber} → ${entry.upstreamIssueUrl} (${formatDate(entry.shippedAt)})`
        )
        .join('\n');
      linkageBlocks.push(`Shipped issues:\n${lines}`);
    }

    const pulledIssues = config.pulledIssues ?? {};
    if (Object.keys(pulledIssues).length > 0) {
      const lines = Object.entries(pulledIssues)
        .map(
          ([, entry]) =>
            `  #${entry.internalIssueNumber} ← ${entry.upstreamIssueUrl} (${formatDate(entry.pulledAt)})`
        )
        .join('\n');
      linkageBlocks.push(`Pulled issues:\n${lines}`);
    }

    if (linkageBlocks.length > 0) {
      p.note(linkageBlocks.join('\n\n'), 'Linkages');
    }
  }

  // Show appropriate outro
  if (isSetupComplete) {
    p.outro('✨ Venfork is fully configured!');
  } else {
    const missingRemotes = [];
    if (!hasOrigin) missingRemotes.push('origin');
    if (!noPublic && !hasPublic) missingRemotes.push('public');
    if (!hasUpstream) missingRemotes.push('upstream');

    p.note(
      `Run venfork setup <upstream> to configure:\n  ${missingRemotes.join(', ')}`,
      'Next Steps'
    );
    p.outro('⚠️  Setup incomplete');
  }
}

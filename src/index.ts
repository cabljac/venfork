#!/usr/bin/env node

import * as p from '@clack/prompts';
import {
  cloneCommand,
  setupCommand,
  showHelp,
  stageCommand,
  statusCommand,
  syncCommand,
} from './commands.js';

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    showHelp();
    return;
  }

  switch (command) {
    case 'setup': {
      // Parse --org flag (supports both --org value and --org=value)
      let organization: string | undefined;
      let upstreamUrl = args[1];
      let privateMirrorName = args[2];

      // Check for --org=value format
      const orgEqualArg = args.find((arg) => arg.startsWith('--org='));
      if (orgEqualArg) {
        organization = orgEqualArg.split('=')[1];
        // Remove --org=value from args
        const filteredArgs = args.filter((arg) => !arg.startsWith('--org='));
        upstreamUrl = filteredArgs[1];
        privateMirrorName = filteredArgs[2];
      } else {
        // Check for --org value format
        const orgIndex = args.indexOf('--org');
        if (orgIndex !== -1) {
          organization = args[orgIndex + 1];
          // Remove --org and its value from args
          const filteredArgs = args.filter(
            (_, i) => i !== orgIndex && i !== orgIndex + 1
          );
          upstreamUrl = filteredArgs[1];
          privateMirrorName = filteredArgs[2];
        } else if (process.env.VENFORK_ORG) {
          // Fall back to VENFORK_ORG environment variable
          organization = process.env.VENFORK_ORG;
        }
      }
      // If neither is set, organization remains undefined
      // setupCommand will prompt for confirmation before using personal account

      await setupCommand(upstreamUrl, privateMirrorName, organization);
      break;
    }
    case 'clone':
      await cloneCommand(args[1]);
      break;
    case 'sync':
      await syncCommand(args[1]);
      break;
    case 'stage':
      await stageCommand(args[1]);
      break;
    case 'status':
      await statusCommand();
      break;
    default:
      p.log.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

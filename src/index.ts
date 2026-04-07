#!/usr/bin/env node

import * as p from '@clack/prompts';
import {
  cloneCommand,
  scheduleCommand,
  setupCommand,
  showHelp,
  stageCommand,
  statusCommand,
  syncCommand,
  workflowsCommand,
} from './commands.js';
import { parseSetupCliArgs } from './setup-args.js';
import { parseWorkflowsCliArgs } from './workflows-args.js';

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
      const parsed = parseSetupCliArgs(args.slice(1));
      await setupCommand(
        parsed.upstreamUrl,
        parsed.privateMirrorName,
        parsed.organization,
        parsed.publicForkRepoName
      );
      break;
    }
    case 'clone':
      await cloneCommand(args[1]);
      break;
    case 'sync':
      await syncCommand(args[1]);
      break;
    case 'schedule':
      await scheduleCommand(args[1], args[2]);
      break;
    case 'stage':
      await stageCommand(args[1]);
      break;
    case 'status':
      await statusCommand();
      break;
    case 'workflows': {
      const parsed = parseWorkflowsCliArgs(args.slice(1));
      await workflowsCommand(parsed.action, parsed.workflows);
      break;
    }
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

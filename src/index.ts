#!/usr/bin/env node

import * as p from '@clack/prompts';
import { parseCloneCliArgs } from './clone-args.js';
import {
  cloneCommand,
  issueCommand,
  preserveCommand,
  pullRequestCommand,
  scheduleCommand,
  setupCommand,
  showHelp,
  stageCommand,
  statusCommand,
  syncCommand,
  workflowsCommand,
} from './commands.js';
import { parseIssueCliArgs } from './issue-args.js';
import { parsePreserveCliArgs } from './preserve-args.js';
import { parsePullRequestCliArgs } from './pull-request-args.js';
import { parseSetupCliArgs } from './setup-args.js';
import { parseStageCliArgs } from './stage-args.js';
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
        parsed.publicForkRepoName,
        { noPublic: parsed.noPublic }
      );
      break;
    }
    case 'clone': {
      const parsed = parseCloneCliArgs(args.slice(1));
      await cloneCommand(parsed.vendorRepoUrl, {
        noPublic: parsed.noPublic,
        upstreamUrl: parsed.upstreamUrl,
      });
      break;
    }
    case 'sync':
      await syncCommand(args[1]);
      break;
    case 'schedule':
      await scheduleCommand(args[1], args[2]);
      break;
    case 'stage': {
      const parsed = parseStageCliArgs(args.slice(1));
      await stageCommand(parsed.branch, {
        createPr: parsed.createPr,
        draft: parsed.draft,
        title: parsed.title,
        base: parsed.base,
        internalPrNumber: parsed.internalPrNumber,
        noUpdateExisting: parsed.noUpdateExisting,
      });
      break;
    }
    case 'status':
      await statusCommand();
      break;
    case 'workflows': {
      const parsed = parseWorkflowsCliArgs(args.slice(1));
      await workflowsCommand(parsed.action, parsed.workflows);
      break;
    }
    case 'preserve': {
      const parsed = parsePreserveCliArgs(args.slice(1));
      await preserveCommand(parsed.action, parsed.paths);
      break;
    }
    case 'pull-request': {
      const parsed = parsePullRequestCliArgs(args.slice(1));
      await pullRequestCommand(parsed.pr, {
        branchName: parsed.branchName,
        push: parsed.push,
      });
      break;
    }
    case 'issue': {
      const parsed = parseIssueCliArgs(args.slice(1));
      await issueCommand(parsed.action, parsed.target, {
        title: parsed.title,
      });
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

#!/usr/bin/env node

import { parseCloneCliArgs } from './clone-args.js';
import { commandHelp } from './commands/help.js';
import {
  cloneCommand,
  doctorCommand,
  issueCommand,
  preserveCommand,
  pullRequestCommand,
  scheduleCommand,
  setupCommand,
  showHelp,
  stageCommand,
  syncCommand,
  workflowsCommand,
} from './commands.js';
import { requiresGhAuth } from './dispatch.js';
import { parseDoctorCliArgs } from './doctor-args.js';
import { ensureGhAuth } from './git.js';
import { parseIssueCliArgs } from './issue-args.js';
import { parsePreserveCliArgs } from './preserve-args.js';
import { parsePullRequestCliArgs } from './pull-request-args.js';
import { parseSetupCliArgs } from './setup-args.js';
import { parseStageCliArgs } from './stage-args.js';
import { parseSyncCliArgs } from './sync-args.js';
import { VENFORK_VERSION } from './version.js';
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

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VENFORK_VERSION);
    return;
  }

  const usage = commandHelp(command);
  if (usage && args.slice(1).some((arg) => arg === '-h' || arg === '--help')) {
    console.log(usage);
    return;
  }

  if (requiresGhAuth(command, args.slice(1))) {
    await ensureGhAuth();
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
    case 'sync': {
      const parsed = parseSyncCliArgs(args.slice(1));
      await syncCommand(parsed.branch, { reportIssues: parsed.reportIssues });
      break;
    }
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
    case 'doctor': {
      const parsed = parseDoctorCliArgs(args.slice(1));
      if (!(await doctorCommand({ json: parsed.json }))) {
        process.exitCode = 1;
      }
      break;
    }
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
      console.error(`Unknown command: ${command}. Run \`venfork help\`.`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

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
import { parsePreserveCliArgs } from './preserve-args.js';
import { parsePullCliArgs } from './pull-args.js';
import { parseScheduleCliArgs } from './schedule-args.js';
import { parseSetupCliArgs } from './setup-args.js';
import { parseStageCliArgs } from './stage-args.js';
import { parseSyncCliArgs } from './sync-args.js';
import { VENFORK_VERSION } from './version.js';
import { parseWorkflowsCliArgs } from './workflows-args.js';

const RENAMED: Record<string, string> = {
  'pull-request':
    '`venfork pull-request` is now `venfork pull pr <number-or-url>`.',
  issue:
    '`venfork issue` was split: use `venfork pull issue <number-or-url>` to bring an upstream issue in, or `venfork stage issue <number-or-url>` to publish a mirror issue.',
  status: '`venfork status` is now `venfork doctor`.',
};

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
    const [target, ...targetRest] = args.slice(1);
    const usage = target ? commandHelp(target, targetRest) : null;
    if (usage) {
      console.log(usage);
    } else {
      showHelp();
    }
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VENFORK_VERSION);
    return;
  }

  const usage = commandHelp(command, args.slice(1));
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
    case 'schedule': {
      const parsed = parseScheduleCliArgs(args.slice(1));
      await scheduleCommand(parsed.action, parsed.cron, { auth: parsed.auth });
      break;
    }
    case 'stage': {
      const parsed = parseStageCliArgs(args.slice(1));
      if (parsed.kind === 'issue') {
        await issueCommand('stage', parsed.ref, { title: parsed.title });
        break;
      }
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
    case 'pull': {
      const parsed = parsePullCliArgs(args.slice(1));
      if (parsed.kind === 'pr') {
        await pullRequestCommand(parsed.ref, {
          branchName: parsed.branchName,
          push: parsed.push,
        });
      } else {
        await issueCommand('pull', parsed.ref, { title: parsed.title });
      }
      break;
    }
    default: {
      const renamed = RENAMED[command];
      console.error(
        renamed ?? `Unknown command: ${command}. Run \`venfork help\`.`
      );
      process.exit(1);
    }
  }
}

// A clack prompt whose stdin hits EOF never resolves; the loop then drains
// with the command still pending, and Node would exit 0.
function exitOnAbandonedPrompt(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  process.stderr.write('Cancelled: input ended at a prompt\n');
  process.exit(130);
}

process.on('beforeExit', exitOnAbandonedPrompt);
main()
  .finally(() => {
    process.off('beforeExit', exitOnAbandonedPrompt);
  })
  .catch((error) => {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });

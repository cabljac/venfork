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
import { requiresGhAuth, setupSyncMirror } from './dispatch.js';
import { parseDoctorCliArgs } from './doctor-args.js';
import { CommandExitError, MissingInputError, UsageError } from './errors.js';
import { ensureGhAuth } from './git.js';
import { parsePreserveCliArgs } from './preserve-args.js';
import { parsePullCliArgs } from './pull-args.js';
import { parseScheduleCliArgs } from './schedule-args.js';
import { parseSetupCliArgs } from './setup-args.js';
import { closedOutputExitCode } from './shared/closed-output.js';
import { stderrUi } from './shared/ui.js';
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
 * Parses `args` for `command` and returns the call that runs it. Throws
 * {@link UsageError} before anything runs, so a usage error never waits on
 * gh auth.
 */
function parseCommand(command: string, args: string[]): () => Promise<void> {
  switch (command) {
    case 'setup': {
      const parsed = parseSetupCliArgs(args);
      return () =>
        setupCommand(
          parsed.upstreamUrl,
          parsed.privateMirrorName,
          parsed.organization,
          parsed.publicForkRepoName,
          {
            noPublic: parsed.noPublic,
            syncMirror: setupSyncMirror(),
            prompt: parsed.prompt,
            organizationFromEnv: parsed.organizationFromEnv,
          }
        );
    }
    case 'clone': {
      const parsed = parseCloneCliArgs(args);
      return () =>
        cloneCommand(parsed.vendorRepoUrl, {
          noPublic: parsed.noPublic,
          upstreamUrl: parsed.upstreamUrl,
          publicForkUrl: parsed.publicForkUrl,
          prompt: parsed.prompt,
        });
    }
    case 'sync': {
      const parsed = parseSyncCliArgs(args);
      return () =>
        syncCommand(parsed.branch, { reportIssues: parsed.reportIssues });
    }
    case 'schedule': {
      const parsed = parseScheduleCliArgs(args);
      return () =>
        scheduleCommand(parsed.action, parsed.cron, { auth: parsed.auth });
    }
    case 'stage': {
      const parsed = parseStageCliArgs(args);
      if (parsed.kind === 'issue') {
        return () =>
          issueCommand('stage', parsed.ref, {
            title: parsed.title,
            prompt: parsed.prompt,
          });
      }
      return () =>
        stageCommand(parsed.branch, {
          createPr: parsed.createPr,
          draft: parsed.draft,
          title: parsed.title,
          base: parsed.base,
          internalPrNumber: parsed.internalPrNumber,
          noUpdateExisting: parsed.noUpdateExisting,
          prompt: parsed.prompt,
        });
    }
    case 'doctor': {
      const parsed = parseDoctorCliArgs(args);
      return async () => {
        if (!(await doctorCommand({ json: parsed.json }))) {
          process.exitCode = 1;
        }
      };
    }
    case 'workflows': {
      const parsed = parseWorkflowsCliArgs(args);
      return () => workflowsCommand(parsed.action, parsed.workflows);
    }
    case 'preserve': {
      const parsed = parsePreserveCliArgs(args);
      return () => preserveCommand(parsed.action, parsed.paths);
    }
    case 'pull': {
      const parsed = parsePullCliArgs(args);
      if (parsed.kind === 'pr') {
        return () =>
          pullRequestCommand(parsed.ref, {
            branchName: parsed.branchName,
            push: parsed.push,
          });
      }
      return () =>
        issueCommand('pull', parsed.ref, {
          title: parsed.title,
          prompt: parsed.prompt,
        });
    }
    default:
      throw new UsageError(
        RENAMED[command] ?? `Unknown command: ${command}. Run \`venfork help\`.`
      );
  }
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    showHelp(stderrUi);
    throw new CommandExitError(2);
  }

  if (command === 'help' || command === '--help' || command === '-h') {
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

  const rest = args.slice(1);
  const usage = commandHelp(command, rest);
  if (usage && rest.some((arg) => arg === '-h' || arg === '--help')) {
    console.log(usage);
    return;
  }

  const run = parseCommand(command, rest);
  if (requiresGhAuth(command, rest)) {
    await ensureGhAuth();
  }
  await run();
}

// A clack prompt whose stdin hits EOF never resolves; the loop then drains
// with the command still pending, and Node would exit 0.
function exitOnAbandonedPrompt(): void {
  if (process.stderr.isTTY) process.stderr.write('\x1b[?25h');
  process.stderr.write('Cancelled: input ended at a prompt\n');
  process.exit(130);
}

function exitOnClosedOutput(error: NodeJS.ErrnoException): void {
  const code = closedOutputExitCode(error, process.exitCode);
  if (code === null) throw error;
  process.exit(code);
}

process.stdout.on('error', exitOnClosedOutput);
process.stderr.on('error', exitOnClosedOutput);
process.stdin.on('error', exitOnClosedOutput);
process.on('beforeExit', exitOnAbandonedPrompt);
main()
  .finally(() => {
    process.off('beforeExit', exitOnAbandonedPrompt);
  })
  .catch((error) => {
    if (error instanceof CommandExitError) process.exit(error.exitCode);
    if (error instanceof UsageError || error instanceof MissingInputError) {
      console.error(`Error: ${error.message}`);
      process.exit(2);
    }
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });

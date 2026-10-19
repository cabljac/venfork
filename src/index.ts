#!/usr/bin/env node

import { parseCloneCliArgs } from './clone-args.js';
import { commandHelp, helpTopic } from './commands/help.js';
import {
  approvalCommand,
  cloneCommand,
  doctorCommand,
  isHealthy,
  issueCommand,
  keepCommand,
  pullRequestCommand,
  scheduleCommand,
  setupCommand,
  showHelp,
  stageCommand,
  syncCommand,
  workflowsCommand,
} from './commands.js';
import {
  assertInRepository,
  partialFailureExitCode,
  requiresGhAuth,
  setupSyncMirror,
} from './dispatch.js';
import { parseDoctorCliArgs } from './doctor-args.js';
import {
  CommandExitError,
  errorText,
  exitCodeFor,
  UsageError,
  VenforkError,
} from './errors.js';
import { ensureGhAuth, isGitRepository } from './git.js';
import { normalizeKeepArgs, parseKeepCliArgs } from './keep-args.js';
import { parsePullCliArgs } from './pull-args.js';
import { parseScheduleCliArgs } from './schedule-args.js';
import { parseSetupCliArgs } from './setup-args.js';
import { isPromptFlag } from './shared/args.js';
import { closedOutputExitCode } from './shared/closed-output.js';
import { interruptsClaimed } from './shared/interrupt.js';
import {
  errorEnvelope,
  JSON_FLAG,
  jsonRequested,
  successEnvelope,
  writeEnvelope,
} from './shared/json-output.js';
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
  preserve:
    '`venfork preserve` is now `venfork keep`, for example `venfork keep add <path>`.',
};

const HELP_WORDS = ['help', '--help', '-h'];
const VERSION_WORDS = ['--version', '-v', 'version'];

/** The usage error for `venfork <command>` when no command has that name. */
function unknownCommand(command: string): UsageError {
  return new UsageError(
    RENAMED[command] ?? `Unknown command: ${command}. Run \`venfork help\`.`
  );
}

/** What one command run produced: its `--json` result and exit code. */
interface CommandOutcome {
  result: unknown;
  exitCode: number;
}

const resultOf =
  (run: () => Promise<unknown>) => async (): Promise<CommandOutcome> => ({
    result: await run(),
    exitCode: 0,
  });

/**
 * Parses `args` for `command` and returns the call that runs it. Throws
 * {@link UsageError} before anything runs, so a usage error never waits on
 * gh auth.
 */
function parseCommand(
  command: string,
  args: string[]
): () => Promise<CommandOutcome> {
  switch (command) {
    case 'setup': {
      const parsed = parseSetupCliArgs(args);
      return resultOf(() =>
        setupCommand(
          parsed.upstreamUrl,
          parsed.privateMirrorName,
          parsed.organization,
          parsed.publicForkRepoName,
          {
            noPublic: parsed.noPublic,
            approval: parsed.approval,
            syncMirror: setupSyncMirror(),
            prompt: parsed.prompt,
            organizationFromEnv: parsed.organizationFromEnv,
          }
        )
      );
    }
    case 'clone': {
      const parsed = parseCloneCliArgs(args);
      return resultOf(() =>
        cloneCommand(parsed.vendorRepoUrl, {
          noPublic: parsed.noPublic,
          upstreamUrl: parsed.upstreamUrl,
          publicForkUrl: parsed.publicForkUrl,
          prompt: parsed.prompt,
        })
      );
    }
    case 'sync': {
      const parsed = parseSyncCliArgs(args);
      return resultOf(() => syncCommand({ reportIssues: parsed.reportIssues }));
    }
    case 'schedule': {
      const parsed = parseScheduleCliArgs(args);
      return resultOf(() =>
        scheduleCommand(parsed.action, parsed.cron, { auth: parsed.auth })
      );
    }
    case 'stage': {
      const parsed = parseStageCliArgs(args);
      if (parsed.kind === 'approval') {
        return resultOf(() => approvalCommand(parsed.level, parsed.prompt));
      }
      if (parsed.kind === 'issue') {
        return resultOf(() =>
          issueCommand('stage', parsed.ref, {
            title: parsed.title,
            prompt: parsed.prompt,
          })
        );
      }
      return async () => {
        const result = await stageCommand(parsed.branch, {
          createPr: parsed.createPr,
          draft: parsed.draft,
          title: parsed.title,
          base: parsed.base,
          internalPrNumber: parsed.internalPrNumber,
          noUpdateExisting: parsed.noUpdateExisting,
          dryRun: parsed.dryRun,
          force: parsed.force,
          prompt: parsed.prompt,
        });
        return {
          result,
          exitCode: partialFailureExitCode({ command: 'stage', result }),
        };
      };
    }
    case 'doctor': {
      parseDoctorCliArgs(args);
      return async () => {
        const result = await doctorCommand();
        return { result, exitCode: isHealthy(result) ? 0 : 1 };
      };
    }
    case 'workflows': {
      const parsed = parseWorkflowsCliArgs(args);
      return resultOf(() => workflowsCommand(parsed.action, parsed.workflows));
    }
    case 'keep': {
      const parsed = parseKeepCliArgs(args);
      if (parsed.action === 'add') normalizeKeepArgs(parsed.paths);
      return resultOf(() => keepCommand(parsed.action, parsed.paths));
    }
    case 'pull': {
      const parsed = parsePullCliArgs(args);
      if (parsed.kind === 'pr') {
        return async () => {
          const result = await pullRequestCommand(parsed.ref, {
            branchName: parsed.branchName,
            push: parsed.push,
          });
          return {
            result,
            exitCode: partialFailureExitCode({
              command: 'pull pr',
              result,
              push: parsed.push,
            }),
          };
        };
      }
      return resultOf(() =>
        issueCommand('pull', parsed.ref, {
          title: parsed.title,
          prompt: parsed.prompt,
        })
      );
    }
    default:
      throw unknownCommand(command);
  }
}

const argv = process.argv.slice(2);
const json = jsonRequested(argv[0] ?? '', argv.slice(1));

/**
 * Throws {@link UsageError} for a `--json` run that would print text on
 * stdout (help, `--version`) or that puts `--json` before the command.
 */
function refuseTextOutput(command: string, rest: string[]): void {
  if (command === JSON_FLAG) {
    throw new UsageError(
      'Put --json after the command, for example `venfork sync --json`.'
    );
  }
  if (
    HELP_WORDS.includes(command) ||
    VERSION_WORDS.includes(command) ||
    rest.some((arg) => arg === '-h' || arg === '--help')
  ) {
    throw new UsageError(
      '--json cannot be combined with help or --version, which print text. Run them without --json.'
    );
  }
}

/**
 * Main CLI entry point
 */
async function main(args: string[]): Promise<void> {
  const command = args[0];

  if (!command) {
    showHelp(stderrUi);
    throw new CommandExitError(2);
  }

  const rest = args.slice(1);
  if (json) refuseTextOutput(command, rest);

  if (HELP_WORDS.includes(command)) {
    const [target, ...targetRest] = rest.filter((arg) => !isPromptFlag(arg));
    if (!target || HELP_WORDS.includes(target)) {
      showHelp();
      return;
    }
    const usage =
      helpTopic(target) ??
      commandHelp(
        VERSION_WORDS.includes(target) ? '--version' : target,
        targetRest
      );
    if (!usage) throw unknownCommand(target);
    console.log(usage);
    return;
  }

  if (VERSION_WORDS.includes(command)) {
    console.log(VENFORK_VERSION);
    return;
  }

  const usage = commandHelp(command, rest);
  if (usage && rest.some((arg) => arg === '-h' || arg === '--help')) {
    console.log(usage);
    return;
  }

  const run = parseCommand(command, rest);
  if (requiresGhAuth(command, rest)) {
    await ensureGhAuth();
  }
  await assertInRepository(command, isGitRepository);
  const { result, exitCode } = await run();
  if (json) await writeEnvelope(successEnvelope(result));
  if (exitCode !== 0) process.exitCode = exitCode;
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

/**
 * With `--json`, a SIGINT or SIGTERM still ends with the `cancelled`
 * envelope. A command that claimed the signal (setup cleans up first)
 * reports through its own rejection instead.
 */
function envelopeOnSignal(signal: 'SIGINT' | 'SIGTERM', exitCode: number) {
  process.on(signal, async () => {
    if (interruptsClaimed()) return;
    await writeEnvelope(
      errorEnvelope(new VenforkError(`Interrupted by ${signal}`, 'cancelled'))
    );
    process.exit(exitCode);
  });
}

if (json) {
  envelopeOnSignal('SIGINT', 130);
  envelopeOnSignal('SIGTERM', 143);
}
process.stdout.on('error', exitOnClosedOutput);
process.stderr.on('error', exitOnClosedOutput);
process.stdin.on('error', exitOnClosedOutput);
process.on('beforeExit', exitOnAbandonedPrompt);
main(argv)
  .finally(() => {
    process.off('beforeExit', exitOnAbandonedPrompt);
  })
  .catch(async (error) => {
    if (json) await writeEnvelope(errorEnvelope(error));
    if (!(error instanceof CommandExitError)) {
      stderrUi.log.error(errorText(error));
    }
    process.exit(exitCodeFor(error));
  });

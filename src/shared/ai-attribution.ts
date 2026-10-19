/** Where stage found a line that credits an AI tool. */
export type AiAttributionWhere =
  | 'commit-message'
  | 'commit-author'
  | 'commit-committer'
  | 'pr-title'
  | 'pr-body';

/** One published line that credits an AI tool. */
export interface AiAttribution {
  where: AiAttributionWhere;
  /** Subject of the commit the line is in; absent for the PR title and body. */
  subject?: string;
  /** The line, trimmed. For an author or committer, `Name <email>`. */
  line: string;
}

/** Author and committer as `Name <email>`, and the full message, of one commit. */
export interface CommitText {
  message: string;
  author: string;
  committer: string;
}

const TOOL_NAMES = new Set([
  'aider',
  'amazon q',
  'amazon q developer',
  'amp',
  'anthropic',
  'chatgpt',
  'chatgpt-codex-connector',
  'claude',
  'claude code',
  'cline',
  'codeium',
  'codewhisperer',
  'codex',
  'copilot',
  'copilot-swe-agent',
  'cursor',
  'cursor agent',
  'cursoragent',
  'devin',
  'devin ai',
  'devin-ai-integration',
  'gemini',
  'gemini code assist',
  'gemini-code-assist',
  'github copilot',
  'google-labs-jules',
  'jules',
  'openai',
  'openai codex',
  'opencode',
  'windsurf',
]);

const MODEL_NAME = /^(?:claude|gpt|gemini)-[\w.-]*\d/;

const TOOL_DOMAINS = new Set([
  'aider.chat',
  'ampcode.com',
  'anthropic.com',
  'cline.bot',
  'codeium.com',
  'cognition.ai',
  'cursor.com',
  'cursor.sh',
  'devin.ai',
  'openai.com',
  'opencode.ai',
  'windsurf.com',
]);

const TOOL_KEY_WORDS = new Set([
  'aider',
  'amp',
  'anthropic',
  'chatgpt',
  'claude',
  'cline',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'gemini',
  'jules',
  'openai',
  'opencode',
  'windsurf',
]);

const TOOL_WORDS =
  /\b(?:claude|anthropic|copilot|openai|chatgpt|gpt-?\d\w*|gemini|codex|cursor|devin|aider|codeium|windsurf|codewhisperer|amazon q|amp|jules|cline|opencode|AI)\b|🤖/i;

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):\s*(\S.*)$/;

const PHRASE = /\b(?:generated|written|created) (?:with|by|using)\b(.*)$/i;

function toolName(name: string): boolean {
  const normal = name
    .toLowerCase()
    .replace(/\[bot\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .split(':')[0]
    .replace(/\s+/g, ' ')
    .trim();
  return TOOL_NAMES.has(normal) || MODEL_NAME.test(normal);
}

function toolEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const local = email
    .slice(0, at)
    .toLowerCase()
    .replace(/^\d+\+/, '')
    .replace(/\[bot\]$/, '');
  const domain = email.slice(at + 1).toLowerCase();
  if (domain === 'users.noreply.github.com') return TOOL_NAMES.has(local);
  return (
    TOOL_DOMAINS.has(domain) &&
    (local === 'noreply' || local === 'no-reply' || TOOL_NAMES.has(local))
  );
}

/** True when `Name <email>`, a bare name or a bare email names an AI tool. */
function toolIdentity(value: string): boolean {
  const match = /^(.*?)\s*<([^<>]*)>\s*$/.exec(value.trim());
  if (match) return toolName(match[1]) || toolEmail(match[2]);
  return /^\S+@\S+$/.test(value.trim())
    ? toolEmail(value.trim())
    : toolName(value);
}

function toolTrailer(line: string): boolean {
  const match = TRAILER.exec(line);
  if (!match) return false;
  const key = match[1].toLowerCase();
  return (
    key === 'generated-by' ||
    key.split('-').some((word) => TOOL_KEY_WORDS.has(word)) ||
    toolIdentity(match[2])
  );
}

function toolPhrase(line: string): boolean {
  const rest = PHRASE.exec(line)?.[1];
  return rest !== undefined && (TOOL_WORDS.test(rest) || /🤖/.test(line));
}

/**
 * Lines of `text` that credit an AI tool: a trailer in the last paragraph
 * (when every line of it is `Key: value`) whose key or name/email names a
 * tool, or a "Generated with ..." line anywhere that names one.
 */
function scanText(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim());
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line) paragraphs[paragraphs.length - 1].push(line);
    else if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
  }
  const last = paragraphs.filter((p) => p.length > 0).at(-1) ?? [];
  const trailers = last.every((line) => TRAILER.test(line))
    ? new Set(last)
    : new Set<string>();
  return lines.filter(
    (line) =>
      line && (toolPhrase(line) || (trailers.has(line) && toolTrailer(line)))
  );
}

function subjectOf(message: string): string {
  return (message.split('\n')[0] ?? '').trim();
}

/**
 * Lines in commit message bodies (the subject is skipped) that credit an
 * AI tool, as `commit-message` hits. Stage lists them so a person decides;
 * it never rewrites them.
 * @param messages Full commit messages, oldest first.
 */
export function findAiAttribution(messages: string[]): AiAttribution[] {
  return messages.flatMap((message) => {
    const subject = subjectOf(message);
    const body = message.split('\n').slice(1).join('\n');
    return scanText(body).map((line) => ({
      where: 'commit-message' as const,
      subject,
      line,
    }));
  });
}

/**
 * AI tools named as the author or committer, then in the message body,
 * of each commit.
 * @param commits The published commits, oldest first.
 */
export function findCommitAttribution(commits: CommitText[]): AiAttribution[] {
  return commits.flatMap((commit) => {
    const subject = subjectOf(commit.message);
    const people: AiAttribution[] = [];
    if (toolIdentity(commit.author)) {
      people.push({ where: 'commit-author', subject, line: commit.author });
    }
    if (toolIdentity(commit.committer)) {
      people.push({
        where: 'commit-committer',
        subject,
        line: commit.committer,
      });
    }
    return [...people, ...findAiAttribution([commit.message])];
  });
}

/**
 * AI attribution in the upstream PR title ("Generated with ..." phrases)
 * and body (as for a commit body). Pass only the text stage publishes.
 * @param title The PR title, or undefined when it is not published.
 * @param body The redacted PR body, or undefined when it is not published.
 */
export function findPrAttribution(
  title: string | undefined,
  body: string | undefined
): AiAttribution[] {
  const titleLine = title?.trim() ?? '';
  return [
    ...(titleLine && toolPhrase(titleLine)
      ? [{ where: 'pr-title' as const, line: titleLine }]
      : []),
    ...(body
      ? scanText(body).map((line) => ({ where: 'pr-body' as const, line }))
      : []),
  ];
}

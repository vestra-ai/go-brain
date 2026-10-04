/**
 * The pull-request tool's words on a permission card (engineer teammates, Git train G3): the
 * one-liner and the card for `github_pull_request`. Its own module so describe-tool.ts, at its
 * size ratchet, only routes to it.
 */
import type { ToolCall } from '../contract/harness.js';
import type { PermissionAsk, PermissionAskDetail } from './describe-tool.js';

const MAX_TITLE_PREVIEW = 60;
const MAX_COMMENT_PREVIEW = 90;

const text = (input: unknown, key: string): string | null => {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : null;
};
const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** What the call does, on which repository, in plain words. */
export function describePullRequest(input: unknown): string {
  const repo = text(input, 'repository');
  const on = repo ? ` on github.com/${repo}` : ' on GitHub';
  const n = input && typeof input === 'object' ? (input as Record<string, unknown>).number : undefined;
  const pr = typeof n === 'number' ? `pull request #${n}` : 'a pull request';
  switch (text(input, 'action')) {
    case 'create': return `Open a pull request${on}`;
    case 'comment': return `Comment on ${pr}${on}`;
    case 'view': return `Look at ${pr}${on}`;
    case 'list': return `List the open pull requests${on}`;
    case 'connect': return `Ask to connect GitHub${repo ? ` for github.com/${repo}` : ''}`;
    default: return `Work with pull requests${on}`;
  }
}

/** The card: the title and the branches for a new one, the words of a comment, and a button that names the act. */
export function pullRequestCard(call: ToolCall, headline: string): Omit<PermissionAsk, 'reasonLine'> {
  const action = text(call.toolInput, 'action');
  const details: PermissionAskDetail[] = [];
  if (action === 'create') {
    const title = text(call.toolInput, 'title');
    if (title) details.push({ label: 'Title', value: truncate(title, MAX_TITLE_PREVIEW) });
    const head = text(call.toolInput, 'head');
    if (head) details.push({ label: 'Branch', value: `${head} into ${text(call.toolInput, 'base') ?? 'the default branch'}` });
  }
  if (action === 'comment') {
    const body = text(call.toolInput, 'body');
    if (body) details.push({ label: 'Comment', value: `"${truncate(body, MAX_COMMENT_PREVIEW)}"`, tone: 'quote' });
  }
  const actionLabel = action === 'create' ? 'Open pull request' : action === 'comment' ? 'Comment' : 'Allow once';
  return { headline, details, actionLabel };
}

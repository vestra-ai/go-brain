/**
 * forwardResumeBreadcrumbText — the words of the forward-resume breadcrumb, chosen by
 * what the person actually did with the card.
 *
 * The breadcrumb used to say "The connection for the earlier X request is now
 * available" for every kind. That sentence is written for composio_auth. Live task
 * 28edef30 (2026-09-28) wrote it after a stale APPROVAL card, so the model read that a
 * connection it never asked for had arrived. A declined card was worse: "Continue that
 * request" invited the very step the person refused. So:
 *   - a decline of any kind: the step was declined, do not run it;
 *   - tool_permission allow: "The person approved the earlier X step." (the breadcrumb
 *     sits in a user-role slot, so "You approved" could read as the model approving);
 *   - composio_auth allow: the connection sentence, unchanged;
 *   - any other kind: the person answered, but the answer is NOT here. The deferred slot
 *     is immutable and the outcome's content is dropped (journal.ts reconcileInteractions,
 *     the forward-resume branch), so "was answered" would promise the model an answer it
 *     never gets. It says so, and to ask again if it still needs it.
 * Model-facing text: no em dashes (the model echoes them into user-facing replies).
 */

import type { InteractionKind, InteractionOutcome } from '../../contract/interaction.js';

/** What the breadcrumb needs from each resolved pause (a ForwardResumeDirective fits). */
export interface ResolvedPause {
  kind: InteractionKind;
  toolName: string;
  outcome: InteractionOutcome;
}

type Lead = 'declined' | 'approved' | 'connected' | 'answered' | 'asked';

const LEADS: Record<Lead, (named: string) => string> = {
  declined: (named) => `The ${named} request was declined, so do not run it.`,
  approved: (named) => `The person approved the ${named} step.`,
  connected: (named) => `The connection for the ${named} request is now available.`,
  answered: (named) =>
    `The person answered the ${named} request after you had moved on; that answer is not in this conversation. If you still need it, ask again.`,
  asked: (named) =>
    `The person answered the ${named} question after you had moved on; that answer is not in this conversation. If you still need it, ask again.`,
};

function leadOf(p: ResolvedPause): Lead {
  if (p.outcome.behavior === 'deny') return 'declined';
  if (p.kind === 'tool_permission') return 'approved';
  if (p.kind === 'composio_auth') return 'connected';
  return p.kind === 'ask_question' ? 'asked' : 'answered';
}

export function forwardResumeBreadcrumbText(resolved: readonly ResolvedPause[]): string {
  // One sentence per lead, naming its tools in first-seen order (one combined entry).
  const names = new Map<Lead, string[]>();
  for (const p of resolved) {
    const lead = leadOf(p);
    const list = names.get(lead) ?? [];
    if (p.toolName) list.push(p.toolName);
    names.set(lead, list);
  }
  const leads = [...names].map(([lead, tools]) => LEADS[lead](tools.length ? `earlier ${tools.join(', ')}` : 'earlier'));
  // Continue only what can run again; an answer that is not here already says what to do.
  const next = names.has('approved') || names.has('connected')
    ? ' Continue that request, taking into account everything discussed since.'
    : names.has('declined') ? ' Carry on, taking into account everything discussed since.' : '';
  return `[System] ${leads.join(' ')}${next}`;
}

import type { TurnOutcome, TurnOutcomeKind } from './turn-outcome.js';

/**
 * User-facing status bucket for a turn's terminal reason.
 * - ok: clean completion (no badge).
 * - truncated: finished partially (output or context limit) — offers Continue.
 * - stopped: ended on purpose (user, policy, limit, declined) — not an error.
 * - paused: waiting on a tool result (HITL; owned by the K5 workstream).
 * - failed: an error reached the user (the ErrorBlock card owns the detail).
 */
export type TerminalReasonStatus = 'ok' | 'truncated' | 'stopped' | 'paused' | 'failed';

export interface TerminalReasonView {
  status: TerminalReasonStatus;
  /**
   * User-facing one-liner. Empty string for `ok` (no badge). The labels authored
   * here carry no em dashes and never say "Claude"; the one exception is copy an
   * ENGINE supplies on the outcome (`auth_error.message`, `billing_error.message`),
   * which founder ruling R9 lets name the account the user is being asked to fix.
   */
  label: string;
  /** Echoed for telemetry/parity assertions; the UI may branch on it. */
  kind: TurnOutcomeKind;
}

/**
 * Single source of truth: TurnOutcome (kind + raw.subtype) -> user-facing terminal reason.
 * Total over all 19 TurnOutcome kinds. `truncated` is DERIVED from a `completed`
 * outcome whose `raw.subtype` is `max_tokens` (output cap) or `context_exceeded`
 * (clean context overflow) — there is no `truncated` kind.
 *
 * This generalizes (and over time replaces) the lossy `outcomeKindToLegacyCategory`
 * adapter in apps/sandbox/src/sdk/processor.ts. See
 * docs/research/2026-06-17-terminal-reason-deep-understanding.md.
 */
export function terminalReasonFor(outcome: TurnOutcome): TerminalReasonView {
  const kind = outcome.kind;
  const view = (status: TerminalReasonStatus, label: string): TerminalReasonView => ({ status, label, kind });

  switch (kind) {
    case 'completed': {
      const sub = outcome.raw.subtype;
      if (sub === 'max_tokens') return view('truncated', 'Response truncated (token limit)');
      if (sub === 'context_exceeded') return view('truncated', 'Response cut off (context window full)');
      return view('ok', '');
    }
    case 'refused':
      return view('stopped', 'Request was declined');
    case 'deferred':
      return view('paused', 'Waiting on a tool result');
    case 'max_turns':
      return view('stopped', 'Turn limit reached');
    case 'max_budget':
      return view('stopped', 'Budget limit reached');
    case 'max_structured_output_retries':
      return view('failed', 'Could not format the response');
    case 'user_aborted':
      return view('stopped', 'Stopped');
    case 'hook_blocked':
      return view('stopped', 'Blocked by policy');
    case 'task_cap':
      return view('stopped', 'Task limit reached');
    case 'detached':
      // NOT 'stopped'. The Stop button could not reach the agent, so the turn may
      // still be running — calling it stopped is the exact lie this kind exists to
      // remove. 'failed' is the only status that makes the web render the card on a
      // PARTIAL turn too (streamingHandlers gates on terminalReasonFor().status ===
      // 'failed'); under 'paused' a user who stopped after some output had streamed
      // would be told nothing at all.
      return view('failed', 'Stop not confirmed');
    case 'context_exceeded':
      return view('failed', 'Conversation too long to process');
    case 'rate_limited':
      return view('failed', 'Service is busy, try again shortly');
    case 'image_error':
      return view('failed', 'Image could not be processed');
    case 'request_invalid':
      // Names the HISTORY, not the service and not the user's message. The fault
      // is ours, the user did nothing wrong, and the thing that could not be sent
      // is the conversation so far — which is also the hint that a fresh task
      // works. Never "The AI service had an issue": that sent a customer to wait
      // out an outage that did not exist.
      return view('failed', 'Conversation history could not be sent');
    case 'model_error':
      return view('failed', 'The AI service had an issue');
    case 'model_unavailable':
      return view('failed', 'The selected model is unavailable');
    case 'auth_error':
      // Engine-supplied copy wins. The default blames US ("with the AI service"),
      // which is right for a Vestra-side credential fault and FALSE on an engine
      // running the user's own plan — nothing is wrong on our side, their account
      // simply needs connecting.
      //
      // This is the label that MATTERS most for that case: the web's ErrorBlock
      // card is synthesized in the client store and never persisted, so after a
      // reload the turn footer's label is the only surviving evidence. A user who
      // reads "authentication issue with the AI service" there concludes Vestra is
      // broken and never thinks to reconnect their plan.
      //
      // An empty message falls back — the footer must never render a blank
      // warning row. Every other engine sends no message and is unchanged.
      return view('failed', outcome.message || 'Authentication issue with the AI service');
    case 'billing_error':
      // WHOSE account it is decides the copy, by the typed owner (never by whether a
      // message is present). The person's own plan: the engine's sentence names THEIR
      // account. Otherwise the credit that ran out is ours (the key behind a native
      // lane), and the old "Service temporarily unavailable" sent the person to wait out
      // something no wait fixes. Say whose it is, that we know, and what works now. Never
      // "busy": that is rate_limited's word, and it promises a retry will land (staging
      // 2026-10-01, Google 402 read as "Service is busy").
      return view(
        'failed',
        outcome.owner === 'person'
          ? outcome.message || 'Your plan needs attention'
          : 'This model is out of credit on our side. The team has been alerted, try another model',
      );
    case 'network_error':
      // Reads next to a Retry button (the turn footer's honest failed line), so
      // the label states WHAT broke and lets the affordance say what to do —
      // "…, retry to continue" duplicated the button beside it.
      return view('failed', 'Connection to the model broke');
    case 'unknown':
      return view('failed', 'The agent ran into an issue');
  }
}

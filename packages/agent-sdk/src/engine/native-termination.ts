import { APIUserAbortError, AnthropicError, APIConnectionError } from '@anthropic-ai/sdk';
import type { TurnOutcome, TerminationRaw, ModelUsageSummary } from '../contract/turn-outcome.js';
import { classifyProviderError, type ProviderErrorSpec } from './error-authority.js';
import { isSeveredStream, type SeveranceSpec } from './severed-recognizer.js';

export { isSeveredSocketError } from './severed-recognizer.js';
export { STREAM_SEVERED_SUBTYPE } from './error-authority.js';

function raw(subtype: string, extra: Partial<TerminationRaw> = {}): TerminationRaw {
  return { subtype, errors: [], ...extra };
}

/**
 * Deploy-seam ladder 1 — the mid-stream severance recognizer.
 *
 * A Railway restart (= every staging merge) severs every in-flight native model
 * stream at the Anthropic proxy (ANTHROPIC_BASE_URL → /api/proxy/anthropic). The
 * SSE dies, readStream's for-await ends, and `s.finalMessage()` throws
 * `AnthropicError('stream ended without producing a Message with role=assistant')`
 * (@anthropic-ai/sdk lib/MessageStream.mjs:341, v0.93.0) — an error with NO
 * `status` that used to fall through to the terminal catch-all model_error: no
 * retry, the whole turn burned (incident a7ea0665, 2026-07-08).
 *
 * Matched STRUCTURALLY where possible: the SDK wrapper classes by instanceof and
 * the socket-level disconnects by `code` (walking `cause`). The one message-string
 * match is the finalMessage sentinel — the SDK throws a bare `AnthropicError` (its
 * BASE class) with no discriminating field, so the exact message IS the structure;
 * it lives in this ONE named constant, never scattered.
 */
export const ANTHROPIC_SEVERED_STREAM_MESSAGE =
  'stream ended without producing a Message with role=assistant';

/**
 * The Anthropic dialect's SEVERANCE SPEC — per-SDK FACTS only. The policy (order,
 * abort exclusion, the HTTP-status guard, the socket walk) lives once in
 * engine/severed-recognizer.ts and is shared with every other lane.
 *
 * The sentinel arm keeps its extra class check: the SDK throws a bare
 * `AnthropicError` for it, so requiring the class as well as the message keeps a
 * look-alike plain `Error` from matching.
 */
export const ANTHROPIC_SEVERANCE_SPEC: SeveranceSpec = {
  isAbort: (err) => err instanceof APIUserAbortError,
  isConnectionError: (err) => err instanceof APIConnectionError,
  sdkSentinels: {
    messages: [ANTHROPIC_SEVERED_STREAM_MESSAGE],
    guard: (err) => err instanceof AnthropicError,
  },
};

export function isSeveredStreamError(err: unknown): boolean {
  return isSeveredStream(err, ANTHROPIC_SEVERANCE_SPEC);
}

/**
 * The Anthropic dialect's ERROR SPEC — per-SDK FACTS only; the policy (order,
 * status ladder, the one network net, raw-byte conventions) lives once in
 * engine/error-authority.ts. This spec plus that policy replaces the old
 * classifier body branch-for-branch; every case the termination suites pin
 * classifies byte-identically.
 */
export const ANTHROPIC_ERROR_SPEC: ProviderErrorSpec = {
  name: 'anthropic',
  abortClasses: [APIUserAbortError],
  // The SDK's structured error type: ctor arg 5 on every APIError it builds —
  // HTTP errors via generate() (core/error.js:36-67) AND in-stream `event: error`
  // frames via core/streaming.js:83-86, which carry NO status. `.error` is the
  // BODY ENVELOPE ({type:'error',error:{type,…}}), so `.error.type` is always the
  // literal 'error'; the envelope's inner `.error.error.type` covers an SDK that
  // left `.type` null, then the bare `.error.type` covers the unwrapped legacy
  // `{error:{type}}` shape.
  codeOf: (err) => {
    const e = err as
      | { type?: unknown; error?: { type?: unknown; error?: { type?: unknown } } }
      | null
      | undefined;
    const t = e?.type ?? e?.error?.error?.type ?? e?.error?.type;
    return typeof t === 'string' ? t : undefined;
  },
  // The wire's status↔type pairing is stable (429 rate_limit_error, 529
  // overloaded_error, 500 api_error, 413 request_too_large …), so a status-bearing
  // hit stamps the status it came with; the rows declare NO statusFallback so a
  // status-less in-stream frame stamps `api_error_type` instead — the W1-C bytes.
  // An unknown type (invalid_request_error included) deliberately has no row: the
  // retry set is not widened, and the 400 prose rules below stay the decider.
  // request_too_large is real wire (413) though absent from the SDK's closed
  // ErrorType union; payload_too_large is its documented sibling.
  codes: {
    overloaded_error: { kind: 'model_unavailable' },
    api_error: { kind: 'model_unavailable' },
    timeout_error: { kind: 'model_unavailable' },
    not_found_error: { kind: 'model_unavailable' },
    rate_limit_error: { kind: 'rate_limited' },
    authentication_error: { kind: 'auth_error' },
    permission_error: { kind: 'auth_error' },
    billing_error: { kind: 'billing_error' },
    request_too_large: { kind: 'context_exceeded' },
    payload_too_large: { kind: 'context_exceeded' },
  },
  // The documented prose exception, carried VERBATIM as named rules: Anthropic
  // returns 400 invalid_request_error for credit/context/image failures with only
  // the message to distinguish them. Order is load-bearing: too_many_images (a
  // context overflow) must precede image_rejected, whose verb net would otherwise
  // capture it.
  messageRules: [
    /*
     * OUR request was malformed — first, because it is the most specific rule
     * here and cannot collide with the ones below (no "image", no "too long",
     * no "credit balance").
     *
     * Extended thinking is replay-contracted: a `thinking` block must go back
     * byte-exact with its signature, which covers the blocks that PRECEDED it.
     * Lose one of those and the API refuses the whole request, every time, until
     * the stored history is repaired — prod 09-16, where it read as a frozen task
     * for an hour under the label "The AI service had an issue".
     *
     * WORDING-GATED and tight, like image_rejected: the thinking/signature family
     * only. A generic invalid_request_error still falls to model_error — naming a
     * fault ours when we have not diagnosed it is the same dishonesty in reverse.
     */
    {
      name: 'thinking_replay_invalid',
      on: [400],
      kind: 'request_invalid',
      statusFallback: 400,
      test: (m) =>
        /\bthinking\b/i.test(m) &&
        /cannot be modified|must remain as they were|invalid signature/i.test(m),
    },
    // 413-class byte overflow (a huge tool result / too many inlined images —
    // Net 3, the letterhead incident) can also arrive as wording on another
    // status, so this net is any-status like the branch it replaces.
    {
      name: 'body_too_large',
      on: 'any',
      kind: 'context_exceeded',
      statusFallback: 413,
      test: (m) => /request body is too large|payload too large/i.test(m),
    },
    // Credit depletion is 400 invalid_request_error on the real wire, NOT 402.
    {
      name: 'credit_balance',
      on: [400],
      kind: 'billing_error',
      statusFallback: 400,
      test: (m) => /credit balance is too low/i.test(m),
    },
    {
      name: 'context_too_long',
      on: [400],
      kind: 'context_exceeded',
      statusFallback: 400,
      test: (m) => /too long|context|maximum.*tokens/i.test(m),
    },
    // Image COUNT overflow (distinct from the byte limit) is a context overflow.
    {
      name: 'too_many_images',
      on: [400],
      kind: 'context_exceeded',
      statusFallback: 400,
      test: (m) =>
        /too many images|maximum of \d+ images|images?\s+(is|are)\s+allowed|images?\s+per\s+request/i.test(m),
    },
    // WORDING-GATED and tight: must mention an image AND a rejection verb, so it
    // cannot sweep a generic validation/schema 400. Without it an image rejection
    // drops to a generic model_error and the user never learns the attached image
    // was the problem. Mirrors the Claude SDK arm's image_error outcome
    // (apps/sandbox/src/sdk/termination.ts).
    {
      name: 'image_rejected',
      on: [400],
      kind: 'image_error',
      statusFallback: 400,
      test: (m) =>
        /\bimage\b/i.test(m) &&
        /could not process|unsupported|invalid|exceeds|does not match|too large|unable to/i.test(m),
    },
  ],
  severance: ANTHROPIC_SEVERANCE_SPEC,
};

/** Map a thrown Anthropic SDK error (or abort) into a terminal TurnOutcome. Never throws. */
export function classifyAnthropicError(err: unknown, phase: 'streaming' | 'tools' = 'streaming'): TurnOutcome {
  return classifyProviderError(err, ANTHROPIC_ERROR_SPEC, phase);
}

/** Map a clean Anthropic stop_reason + usage into a completed/refused/max_turns outcome. */
export function classifyAnthropicTermination(args: {
  stopReason: string | null;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  modelUsage: ModelUsageSummary;
  summaryText: string;
}): TurnOutcome {
  const { stopReason, costUsd, numTurns, durationMs, modelUsage, summaryText } = args;
  if (stopReason === 'refusal') {
    return { kind: 'refused', text: summaryText, raw: raw('refusal', { stop_reason: stopReason }) };
  }
  if (stopReason === 'max_tokens') {
    // partial output; treat as completed with the partial summary (parity with how the SDK surfaces it)
    return {
      kind: 'completed',
      summary: summaryText,
      costUsd,
      numTurns,
      durationMs,
      modelUsage,
      raw: raw('max_tokens', { stop_reason: stopReason }),
    };
  }
  if (stopReason === 'model_context_window_exceeded') {
    // Claude 4.5+: input_tokens + max_tokens overflowed the context window mid-generation.
    // The API accepts the request and ends the turn cleanly (no error thrown), so this is a
    // partial-output context overflow — completed with the partial summary, distinct subtype.
    return {
      kind: 'completed',
      summary: summaryText,
      costUsd,
      numTurns,
      durationMs,
      modelUsage,
      raw: raw('context_exceeded', { stop_reason: stopReason }),
    };
  }
  return {
    kind: 'completed',
    summary: summaryText,
    costUsd,
    numTurns,
    durationMs,
    modelUsage,
    raw: raw('success', { stop_reason: stopReason }),
  };
}

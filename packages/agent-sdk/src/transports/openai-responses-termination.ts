import { APIUserAbortError, APIConnectionError } from 'openai';
import type { TurnOutcome, TerminationRaw, ModelUsageSummary } from '../contract/turn-outcome.js';
import { BODYLESS_5XX_SUBTYPE, classifyProviderError, type ProviderErrorSpec } from '../engine/error-authority.js';
import { isSeveredStream, type SeveranceSpec } from '../engine/severed-recognizer.js';

function raw(subtype: string, extra: Partial<TerminationRaw> = {}): TerminationRaw {
  return { subtype, errors: [], ...extra };
}

/**
 * Re-exported from the engine's shared sentinel registry (severed-recognizer.ts),
 * where EVERY lane's recognizer checks them. Kept as named exports here so the
 * transports and their tests import the string from beside their own classifier.
 */
export {
  CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE,
  OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE,
} from '../engine/severed-recognizer.js';

/**
 * The OpenAI dialect's SEVERANCE SPEC — per-SDK FACTS only. The policy lives once
 * in engine/severed-recognizer.ts and is shared with every other lane, so this
 * classifier cannot drift from the Anthropic one the way the two arms already had.
 *
 * Both OpenAI-shaped transports use it: the Chat Completions breadth lane
 * (GLM/Luna, DeepSeek, Fireworks, Kimi, xAI, …) and the Responses lane. Before the
 * spec existed neither had a recognizer at all, so a severed round on those lanes
 * was terminal — staging task 47faf57f, 2026-08-20 13:30:04Z.
 */
export const OPENAI_SEVERANCE_SPEC: SeveranceSpec = {
  isAbort: (err) => err instanceof APIUserAbortError,
  isConnectionError: (err) => err instanceof APIConnectionError,
  // No `sdkSentinels`: the openai SDK throws no message-only premature-end error.
  // Our own two sentinels live in the shared STREAM_END_SENTINELS registry.
};

export function isOpenAISeveredStreamError(err: unknown): boolean {
  return isSeveredStream(err, OPENAI_SEVERANCE_SPEC);
}

/**
 * The OpenAI dialect's ERROR SPEC — per-SDK FACTS only; the policy lives once in
 * engine/error-authority.ts. Until that module this file's classifier was a
 * hand-kept copy ("Mirrors classifyAnthropicError exactly … this mirror had
 * missed it"); now a policy fix reaches both arms by construction.
 *
 * A recurring OpenAI fact the rows encode: the SAME upstream failure reaches us
 * two ways — (a) a THROWN APIError, and (b) the #1110 error-surfacing re-throw of
 * a proxy SSE `response.failed` / top-level `error` event, a plain Error carrying
 * the JSON error `code` and NO http status. Code-first classification (the
 * policy's step 3) is what makes both paths land identically; each row's
 * statusFallback is the status the same failure wears when it DOES arrive over
 * HTTP — the api_error_status bytes the live classifier stamped.
 */
export const OPENAI_ERROR_SPEC: ProviderErrorSpec = {
  name: 'openai',
  // `.code` is set by the real openai SDK's APIError from the JSON body's
  // error.code (core/error.js:17); duck-typed objects with `.code` ride the same
  // read. xAI stamps PROSE into a `code` field — exact rows can never match it,
  // so its 401/429s classify by status, which is correct.
  abortClasses: [APIUserAbortError],
  codeOf: (err) => {
    const e = err as { code?: unknown; type?: unknown } | null | undefined;
    if (typeof e?.code === 'string') return e.code;
    // OpenAI stamps some transient failures with `code: null` and ONLY a `type`
    // (an in-stream error frame the SDK throws as APIError with no http status —
    // prod task b7867465, 2026-08-31: `type: 'service_unavailable_error'`, "Unable
    // to verify model access right now. Please retry."). The type is the same
    // vocabulary as the code rows (server_error is both), so it rides the same
    // table; the code still wins whenever both are present.
    return typeof e?.type === 'string' ? e.type : undefined;
  },
  codes: {
    // Dead credits — no retry. Arrives status=UNDEFINED + code (verified live
    // against the proxy), so a status guard alone MISSES it.
    insufficient_quota: { kind: 'billing_error', statusFallback: 429 },
    // The account's hard spend cap: the same dead end as insufficient_quota, which the
    // 429 ladder would otherwise read as a rate limit and retry.
    billing_hard_limit_reached: { kind: 'billing_error', statusFallback: 429 },
    rate_limit_exceeded: { kind: 'rate_limited', statusFallback: 429 },
    request_too_large: { kind: 'context_exceeded', statusFallback: 413 },
    payload_too_large: { kind: 'context_exceeded', statusFallback: 413 },
    context_length_exceeded: { kind: 'context_exceeded', statusFallback: 400 },
    // PR4 cross-issuer recovery: kind model_error (inherits the Retry UX) with the
    // DISTINCT subtype startStreamWithRetry keys its one-time recovery on
    // (disable encrypted-reasoning replay + retry).
    invalid_encrypted_content: { kind: 'model_error', subtype: 'invalid_encrypted_content', statusFallback: 400 },
    // OpenAI stamps server_error on its overloads ("Our servers are currently
    // overloaded…") — the most transient class there is; it was classifying to
    // non-retryable model_error and dying with zero retries (triage 2026-08-19).
    server_error: { kind: 'model_unavailable', statusFallback: 503 },
    overloaded: { kind: 'model_unavailable', statusFallback: 503 },
    // Type-only transient frames (see codeOf): the provider says "please retry",
    // so the round is re-asked at the pre-commit boundary instead of burning
    // the turn as model_error (zero retries — the 08-31 incident).
    service_unavailable_error: { kind: 'model_unavailable', statusFallback: 503 },
    rate_limit_error: { kind: 'rate_limited', statusFallback: 429 },
  },
  // OpenAI stamps an open FAMILY of image codes (invalid_image, invalid_image_url,
  // invalid_image_format, image_parse_error, …) — matched by shape, never listed
  // exhaustively, exactly as the live classifier did (audit S7).
  codeFamilies: [
    { name: 'image_codes', kind: 'image_error', statusFallback: 400, test: (c) => /image/i.test(c) },
  ],
  messageRules: [
    // 413-class byte overflow — the model proxy's Fastify bodyLimit (the stamp
    // incident) or a provider's own request-size cap (the letterhead incident).
    // A byte overflow is a CONTEXT overflow: the oversized transcript is
    // persisted, so a Retry can never succeed — only the context_exceeded
    // recovery UX can.
    {
      name: 'body_too_large',
      on: 'any',
      kind: 'context_exceeded',
      statusFallback: 413,
      test: (m) => /request body is too large|payload too large/i.test(m),
    },
    // Context wording fires on 400 OR status-less (the #1110 re-throw); any other
    // status keeps its stronger signal. Without the status-less arm, a
    // code-less overflow re-throw dropped to model_error and stripped the user's
    // Compact/Continue recovery UX (which keys off context_exceeded).
    {
      name: 'context_too_long',
      on: [400, undefined],
      kind: 'context_exceeded',
      statusFallback: 400,
      test: (m) => /too long|context|maximum.*tokens/i.test(m),
    },
    // The wording twin of the invalid_encrypted_content row (the net is tight: it
    // names the exact error).
    {
      name: 'invalid_encrypted_content',
      on: 'any',
      kind: 'model_error',
      subtype: 'invalid_encrypted_content',
      statusFallback: 400,
      test: (m) => /invalid_encrypted_content/i.test(m),
    },
    // Image rejection wording — tight, must mention an image AND a rejection verb
    // (with the download-failure verbs OpenAI uses for URL fetches).
    {
      name: 'image_rejected',
      on: [400],
      kind: 'image_error',
      statusFallback: 400,
      test: (m) =>
        /\bimage\b/i.test(m) &&
        /could not process|unsupported|invalid|exceeds|does not match|too large|unable to|failed to (?:download|fetch)|error (?:while )?downloading/i.test(m),
    },
    // A BODYLESS 5xx — the edge answered, the upstream did not. There is no body, so
    // no code and no type: the wording is the only fact there is, and when the failure
    // reaches us as a relayed SSE error (a plain Error with the message and nothing
    // else) every net below missed it and it landed on the terminal model_error, so the
    // turn burned on the first attempt (staging 6cffd831, b2d2b365). Anchored on the
    // three statuses worth another attempt, so a bodyless 4xx stays terminal. The
    // subtype is what buys this class its longer backoff at the retry boundary.
    // statusFallback only applies to the status-less relay; a frame that DID carry its
    // http status keeps the real one, and either way the message names it.
    {
      name: 'bodyless_5xx',
      on: 'any',
      kind: 'model_unavailable',
      subtype: BODYLESS_5XX_SUBTYPE,
      statusFallback: 502,
      test: (m) => /^50[234] status code \(no body\)$/.test(m.trim()),
    },
    // Overload wording without a code or status (SSE re-throw). After the
    // context/image nets so a 400 that happens to mention "overloaded" still
    // classifies by its stronger signal.
    {
      name: 'overloaded',
      on: 'any',
      kind: 'model_unavailable',
      statusFallback: 503,
      test: (m) => /\boverloaded\b|server had an error|temporarily unavailable|service unavailable/i.test(m),
    },
  ],
  terminalRules: [
    // 3b defense-in-depth: a strict-schema 400 should fail CLOSED at preflight
    // (openaiStrictPreflightFailure); if one slips through, keep kind model_error
    // (the Retry UX) but tag the DISTINCT subtype so telemetry can tell a schema
    // 400 from a generic model failure. Stamps no status — the historical bytes.
    {
      name: 'schema',
      on: 'any',
      kind: 'model_error',
      subtype: 'schema_error',
      test: (m) => /schema|required|json_schema|response_format/i.test(m),
    },
  ],
  severance: OPENAI_SEVERANCE_SPEC,
};

/**
 * Map a thrown OpenAI Responses API error (or abort) into a terminal TurnOutcome.
 * Never throws. Both OpenAI-shaped transports delegate here (Chat Completions =
 * GLM/Luna, DeepSeek, Fireworks, Kimi, xAI …; and Responses).
 */
export function classifyOpenAIResponsesError(err: unknown, phase: 'streaming' | 'tools' = 'streaming'): TurnOutcome {
  return classifyProviderError(err, OPENAI_ERROR_SPEC, phase);
}

/**
 * Map a clean OpenAI Responses API status into a completed/refused outcome.
 *
 * OpenAI Responses API terminal signals:
 *  - `'completed'`         → completed (normal response.status)
 *  - `'incomplete'`        → completed (partial; response.status, like Anthropic max_tokens)
 *  - `'max_output_tokens'` → completed (partial). NOTE: this is an
 *                            `incomplete_details.reason`, NOT a response.status —
 *                            the caller normalizes it onto stopReason. Handled the
 *                            same as 'incomplete'.
 *  - `'content_filter'`    → refused
 *  - anything else / null  → completed (forward-compatible default)
 */
export function classifyOpenAIResponsesTermination(args: {
  stopReason: string | null;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  modelUsage: ModelUsageSummary;
  summaryText: string;
}): TurnOutcome {
  const { stopReason, costUsd, numTurns, durationMs, modelUsage, summaryText } = args;

  // A soft refusal — the accumulator flips the stopReason to 'refusal' when it
  // captured a `ResponseOutputRefusal` content part (on a status='completed'
  // response). `content_filter` is the hard-block variant. Both → refused,
  // carrying the refusal text (mirrors the Anthropic arm's native-termination.ts).
  if (stopReason === 'refusal' || stopReason === 'content_filter') {
    return {
      kind: 'refused',
      text: summaryText,
      raw: raw('refusal', { stop_reason: stopReason }),
    };
  }

  if (stopReason === 'incomplete' || stopReason === 'max_output_tokens') {
    // Partial output — treat as completed (parity with Anthropic max_tokens)
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

  // 'completed', null, or any future unknown status → completed
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

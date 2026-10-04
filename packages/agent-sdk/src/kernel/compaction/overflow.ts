/**
 * COMPACTION_V2 — overflow classification and the two staleness guards.
 *
 * PURITY CONTRACT (mirrors compactor.ts / trigger.ts):
 *   - No I/O, no clock, no provider SDK. Pure functions over plain fields.
 *   - Never throws. Every degenerate input resolves to "not overflow", because a
 *     false NEGATIVE costs one un-recovered turn while a false POSITIVE burns a
 *     summarize call and rewrites the user's history for nothing.
 *
 * ── CLASSIFICATION ORDER IS THE WHOLE DESIGN ────────────────────────────────
 * A throttle and an overflow are both "the provider said no, something about
 * tokens", and their prose overlaps badly: real rate-limit bodies say "too many
 * tokens", "token rate limit exceeded", "input tokens per minute". Matching an
 * overflow pattern first would classify a throttle as an overflow, and the
 * recovery would answer a temporary "slow down" by permanently destroying the
 * user's conversation. So:
 *
 *   1. THROTTLE EXCLUSIONS FIRST — structured, then prose. Anything that matches
 *      is NOT overflow and never reaches step 2.
 *   2. OVERFLOW, STRUCTURED — HTTP status, provider error `type`/`code`, and the
 *      clean `stop_reason`. These are fields, not sentences.
 *   3. OVERFLOW, PROSE — last resort, and only for a 4xx that already failed
 *      every exclusion. Repo rule (CLAUDE.md): never string-match an API response
 *      as the ONLY signal; here it is the fallback behind two structured layers,
 *      and every prose branch is reachable only after the exclusions cleared.
 */

/** The fields a provider error/termination can offer, all optional. */
export interface OverflowInput {
  /** HTTP status, when the failure came back as an API error. */
  status?: number | undefined;
  /** Provider error discriminator — Anthropic `error.type`, OpenAI `code`. */
  errorType?: string | undefined;
  /** Clean-termination stop reason, when the request SUCCEEDED but ended short. */
  stopReason?: string | null | undefined;
  /** The human-readable message. Consulted LAST and never alone. */
  message?: string | undefined;
  /**
   * True when the response carried a retry-after / rate-limit header. The single
   * most reliable throttle signal there is: a context overflow is never
   * retryable-after-a-wait, so its presence excludes overflow outright.
   */
  retryAfterPresent?: boolean | undefined;
}

export type OverflowVerdict =
  /** An overflow, and which layer proved it (observability + tests). */
  | { overflow: true; signal: 'status' | 'error_type' | 'stop_reason' | 'message' }
  /** Not an overflow. `throttle` means a rate limit deliberately excluded it. */
  | { overflow: false; reason: 'throttle' | 'no_signal' };

/** Provider error discriminators that mean "slow down", never "too big". */
const THROTTLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'rate_limit_error',
  'overloaded_error',
  'insufficient_quota',
  'rate_limit_exceeded',
  'tokens_exceeded_rate_limit',
]);

/**
 * Prose that means a THROTTLE even though it talks about tokens. Checked before
 * any overflow pattern — this is the exclusion list the ordering exists for.
 */
const THROTTLE_PROSE =
  /rate[ _-]?limit|too many requests|requests per|tokens per (?:minute|second|day|hour)|quota|throttl|overloaded|capacity|try again (?:later|in)|temporarily unavailable/i;

/** Provider error discriminators that mean the request was too big. */
const OVERFLOW_ERROR_TYPES: ReadonlySet<string> = new Set([
  'request_too_large',
  'payload_too_large',
  'context_length_exceeded',
  'string_above_max_length',
]);

/**
 * Clean stop reasons that mean the model ran out of context MID-GENERATION. The
 * request succeeded, so nothing throws and no status exists — without this the
 * whole class is invisible to an error-only recovery.
 *
 * `max_tokens` is deliberately ABSENT: it means the OUTPUT cap was reached, which
 * is a normal, healthy truncation on a long answer and must never force-compact.
 */
const OVERFLOW_STOP_REASONS: ReadonlySet<string> = new Set([
  'model_context_window_exceeded',
  'context_length_exceeded',
]);

/** Last-resort prose, reached only for a 4xx that cleared every exclusion. */
const OVERFLOW_PROSE =
  /request body is too large|payload too large|too long|context (?:window|length)|maximum.*tokens|too many images|maximum of \d+ images/i;

/**
 * Classify a provider failure or termination as overflow / not-overflow.
 *
 * See the module header for why the order is load-bearing. TOTAL: unknown shapes
 * fall through to `{ overflow: false, reason: 'no_signal' }`.
 */
export function classifyOverflow(input: OverflowInput): OverflowVerdict {
  const message = input.message ?? '';

  // ── 1. THROTTLE EXCLUSIONS (structured first, then prose) ─────────────────
  if (input.retryAfterPresent === true) return { overflow: false, reason: 'throttle' };
  if (input.status === 429) return { overflow: false, reason: 'throttle' };
  if (input.errorType && THROTTLE_ERROR_TYPES.has(input.errorType)) {
    return { overflow: false, reason: 'throttle' };
  }
  if (THROTTLE_PROSE.test(message)) return { overflow: false, reason: 'throttle' };

  // ── 2. OVERFLOW, STRUCTURED ───────────────────────────────────────────────
  if (input.status === 413) return { overflow: true, signal: 'status' };
  if (input.errorType && OVERFLOW_ERROR_TYPES.has(input.errorType)) {
    return { overflow: true, signal: 'error_type' };
  }
  if (input.stopReason && OVERFLOW_STOP_REASONS.has(input.stopReason)) {
    return { overflow: true, signal: 'stop_reason' };
  }

  // ── 3. OVERFLOW, PROSE — only for a 4xx, only after the exclusions cleared ─
  // Gated on a client-error status so a 500 whose body happens to mention
  // "context" can never masquerade as an overflow.
  if (input.status !== undefined && input.status >= 400 && input.status < 500 && OVERFLOW_PROSE.test(message)) {
    return { overflow: true, signal: 'message' };
  }

  return { overflow: false, reason: 'no_signal' };
}

// ─── The two staleness guards ────────────────────────────────────────────────

/**
 * What an observed overflow remembers about the world when it was raised. Both
 * guards below read only this, so a deferred recovery can always re-check the
 * facts rather than trusting that nothing moved.
 */
export interface OverflowObservation {
  /** The model the overflowing request actually ran on. */
  model: string;
  /** Journal `seq` at the moment the overflow was observed (see the note below). */
  seq: number;
}

/**
 * GUARD 1 — model switch.
 *
 * An overflow raised under a small-context model says nothing about a large one.
 * If the user switches models between the overflow and the recovery (the composer
 * lets them, and a deferred recovery spans turns), the context that overflowed a
 * 200k window may sit comfortably inside a 1M one — and compacting on that stale
 * signal would destroy history to solve a problem that no longer exists.
 *
 * Bails when the CURRENT model's window is strictly larger than the window the
 * overflow was raised under. An equal or smaller window still overflows, so the
 * recovery is still warranted.
 *
 * `windowFor` is injected so this stays pure (the resolver reads the capability
 * registry, which is pure too, but injection keeps the kernel's import surface
 * to its siblings and makes the guard trivially testable).
 */
export function overflowSurvivesModelSwitch(
  observation: OverflowObservation,
  currentModel: string,
  windowFor: (model: string) => number,
): boolean {
  if (observation.model === currentModel) return true;
  return windowFor(currentModel) <= windowFor(observation.model);
}

/**
 * GUARD 2 — post-compaction staleness.
 *
 * An overflow observation describes the context as it was when it was raised. If
 * a compaction has landed SINCE, the context it described is gone: acting on it
 * would compact an already-compacted conversation, and — because the observation
 * is what triggers the compaction — the pair can ping-pong, each compaction
 * leaving the stale signal still armed.
 *
 * Bails when the latest compaction boundary is at or after the observation.
 *
 * ON "COMPARE TIMESTAMPS": entries carry an ISO `timestamp`, but the journal's
 * `seq` is the SAME ordering with none of the failure modes — it is assigned on
 * append, is strictly monotone within a journal, and cannot be perturbed by clock
 * skew or by two entries sharing a millisecond. Comparing seq IS comparing
 * timestamps, done in the journal's own total order.
 */
export function overflowSurvivesCompaction(
  observation: OverflowObservation,
  lastCompactionSeq: number | null,
): boolean {
  if (lastCompactionSeq === null) return true;
  return lastCompactionSeq < observation.seq;
}

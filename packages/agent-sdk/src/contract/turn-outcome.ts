/**
 * TurnOutcome — structured, exhaustive reason a turn ended.
 *
 * This is the ONLY type that feeds UI error/termination decisions. Every
 * SDK result message maps to exactly one TurnOutcome via the sandbox's
 * `classifyTermination()`. Frontend switches on `kind`; NEVER regex-matches
 * strings.
 *
 * Design doc: docs/superpowers/specs/2026-04-19-terminal-reason-design.md
 *
 * Versioning:
 *  - Adding a new `kind` — MINOR change. Frontend must handle it (or it
 *    falls through to the `unknown` UI variant via resolveErrorCopy).
 *  - Removing/renaming a `kind` — BREAKING change. Coordinate across
 *    sandbox + shared + web in one PR.
 *  - Adding a field to an existing `kind` — MINOR change (non-breaking).
 */

/**
 * Summary of rate-limit state at the time of termination.
 * Mirrors the SDK's `SDKRateLimitInfo` but JSON-safe (no SDK imports).
 */
export interface RateLimitInfoSummary {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Unix seconds — when the window resets. */
  resetsAt?: number;
  rateLimitType?:
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
    | 'overage'
    // Added by @anthropic-ai/claude-agent-sdk 0.3.198 (SDKRateLimitInfo).
    | 'seven_day_overage_included';
  utilization?: number;
}

/** Deferred tool-use summary for `deferred` outcomes. */
export interface DeferredToolUseSummary {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Per-model usage aggregate — mirrors SDK's ModelUsage entries. */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type ModelUsageSummary = Record<string, ModelUsageEntry>;

/**
 * Raw termination fields — preserved for debug/telemetry.
 * NEVER consulted by UI. Kept so support engineers can trace back to the
 * exact SDK output when investigating a report.
 */
export interface TerminationRaw {
  subtype: string;
  terminal_reason?: string;
  stop_reason?: string | null;
  api_error_status?: number | null;
  errors: string[];
  last_per_turn_error?:
    | 'authentication_failed'
    | 'billing_error'
    | 'rate_limit'
    | 'invalid_request'
    | 'server_error'
    | 'unknown'
    | 'max_output_tokens'
    // Added in SDK 0.3.144 — classification is a follow-up (P1.5-7).
    | 'oauth_org_not_allowed'
    | 'model_not_found'
    // Added in SDK 0.3.177 — Anthropic 529 transient overload (grouped with server_error).
    | 'overloaded'
    // Claude Code 2.1.284 — account states the person fixes on their own account.
    | 'account_on_hold'
    | 'verification_required'
    | 'cloud_credential_error';
  last_rate_limit_info?: RateLimitInfoSummary;
}

/**
 * TurnOutcome — discriminated union of every way a turn can end.
 *
 * KEEP SYNCED with:
 *  - apps/sandbox/src/sdk/termination.ts — `classifyTermination`
 *  - apps/web/src/lib/resolveErrorCopy.ts — UI copy per kind
 *  - packages/shared/src/schemas/turn-outcome.schema.ts — runtime schema
 */
export type TurnOutcome =
  // ─── Non-error terminations ────────────────────────────────────────────
  | {
      kind: 'completed';
      /** Every round's text, joined: the narration and the final reply together (the consumer product's record). */
      summary: string;
      /**
       * The final reply alone: what the person reads as the answer, with no narration from earlier rounds. Null when
       * the turn ended with no final text (an empty turn's fallback line is not an answer). Absent from an older runner.
       */
      answer?: string | null;
      costUsd: number;
      numTurns: number;
      durationMs: number;
      modelUsage: ModelUsageSummary;
      /**
       * K6 P6: the validated structured-output object, present iff the run
       * declared an `outputFormat` and the terminal constrained call produced a
       * value that passed `validateOutputValue`. Absent on every unconstrained
       * (legacy / Claude-default) completion — so the Claude arm is byte-identical.
       */
      structuredOutput?: unknown;
      raw: TerminationRaw;
    }
  | {
      kind: 'refused';
      /** The model's own refusal text — rendered as the assistant reply. */
      text: string;
      raw: TerminationRaw;
    }
  | {
      kind: 'deferred';
      toolUse: DeferredToolUseSummary;
      raw: TerminationRaw;
    }

  // ─── Limits reached (recoverable with caller action) ───────────────────
  | { kind: 'max_turns'; numTurns: number; raw: TerminationRaw }
  | {
      kind: 'max_budget';
      costUsd: number;
      /**
       * Which constraint actually pinched off the turn. Today the sandbox
       * only ever receives a credit-derived cap (resolvePrewarmArgs in the
       * server always passes userLimitUsd=null), so every max_budget is
       * 'credits' unless a future change starts plumbing a true per-task
       * user-set limit. UI branches on this to decide "Recharge credits"
       * vs "Adjust limit" CTAs. Optional — undefined is treated as
       * 'credits' by the UI for forward compatibility.
       *
       * 'turn_ceiling' is the PER-TURN spend ceiling (live-spend.ts): not an
       * out-of-money state at all — the task is fine, THIS turn ran away — so
       * the honest CTA is "send another message", never "recharge".
       *
       * 'daily_ceiling' is the per-USER DAY governor (server-side, refused at
       * mint): the balance is fine and this turn never opened — the day's
       * budget is spent. It is the only one of the four that time alone
       * clears, so its CTA names midnight UTC as well as the guardrail.
       */
      triggeredBy?: 'credits' | 'task_limit' | 'turn_ceiling' | 'daily_ceiling';
      raw: TerminationRaw;
    }
  | { kind: 'max_structured_output_retries'; raw: TerminationRaw }

  // ─── Explicit stops (user or policy) ───────────────────────────────────
  | {
      kind: 'user_aborted';
      abortPhase: 'streaming' | 'tools';
      raw: TerminationRaw;
    }
  | {
      kind: 'hook_blocked';
      /** `stop` = Stop hook. `other` = PreToolUse/PostToolUse/etc. */
      hookKind: 'stop' | 'other';
      /** Hook's `stopReason` field, if provided (our composio-auth hook sets this). */
      stopReason?: string;
      raw: TerminationRaw;
    }
  // Server-minted only (the stop button's unreachable-agent paths,
  // interaction-handlers.ts AGENT_INTERRUPT): the user pressed Stop and the
  // server could NOT reach the agent to stop it — the turn may still be running.
  // NOT an interrupt: claiming `user_aborted` here settled the task as stopped
  // while a desktop-lane turn kept executing on the user's laptop, still calling
  // tools, still spending their money (the real terminal then arrived AFTER the
  // task was reported stopped, via late-terminal acceptance). This kind says the
  // honest thing instead: we are detached from the turn, and the task resolves
  // itself when the real terminal lands. `raw.subtype` distinguishes the branch
  // ('stop_unreachable' = a live LOCAL lease with no relay, so the cloud
  // wake/kill cannot touch the laptop turn; 'stop_kill_unconfirmed' = WS dead and
  // the process kill confirmed nothing; 'stop_kill_not_permitted' = WS dead and
  // the caller may not spend the per-USER process kill, which is how a stop
  // asked for from a chat surface declines to end that user's other turns as
  // collateral). classifyTermination never produces it.
  | { kind: 'detached'; raw: TerminationRaw }

  // Server-minted only (active-task-cap gate, message-handlers.ts): the user is
  // at their concurrent-active-task limit, so this turn was refused before any
  // runner dispatch. classifyTermination never produces it — the kind exists so
  // the refusal rides the same AGENT_END outcome vocabulary as the model/image
  // gates. `message` carries the user-facing copy with the live cap number.
  | { kind: 'task_cap'; message: string; raw: TerminationRaw }

  // ─── Environmental / upstream errors ───────────────────────────────────
  | { kind: 'context_exceeded'; raw: TerminationRaw }
  | {
      kind: 'rate_limited';
      rateLimitInfo?: RateLimitInfoSummary;
      raw: TerminationRaw;
    }
  | { kind: 'image_error'; message: string; raw: TerminationRaw }
  /*
   * WE built a request the API refused — not an upstream fault. Today's only
   * source is the extended-thinking replay contract: a `thinking` block must be
   * replayed byte-exact with its signature, and if anything it was signed over
   * goes missing the whole request is rejected (prod 09-16, a dropped
   * server_tool_use pair; the task could never make another model call).
   *
   * It is its own kind because `model_error` labels itself "The AI service had an
   * issue", and both halves of that were false: the service was fine and the
   * fault was ours. A blip and a self-inflicted malformed request need different
   * answers — one is waited out, the other is fixed — so they must not share a
   * row. The same reasoning that gave context_exceeded and image_error their own
   * kinds after the letterhead incident.
   */
  | { kind: 'request_invalid'; message: string; raw: TerminationRaw }
  | { kind: 'model_error'; message: string; raw: TerminationRaw }
  | { kind: 'model_unavailable'; message: string; raw: TerminationRaw }
  | {
      kind: 'auth_error';
      /**
       * Optional, engine-supplied copy. The Claude Code engine sets it because the default
       * card blames Vestra, which is wrong when the user's own plan simply needs signing in.
       * Absent on every other arm → that card is unchanged.
       */
      message?: string;
      raw: TerminationRaw;
    }
  | {
      kind: 'billing_error';
      /**
       * WHOSE account ran dry, typed. Absent = OURS: the provider account behind a native
       * lane's Vestra key. Our copy says so ("out of credit on our side, the team has been
       * alerted") and the server files the provider_billing alarm. 'person' = the person's
       * OWN plan (an engine on their subscription): theirs to fix, so their copy and no alarm.
       * Never inferred from `message`: a provider's prose on our own failure must not flip
       * the copy or silence the page.
       */
      owner?: 'person';
      /** Engine-supplied copy for an `owner: 'person'` failure. Ignored on ours. */
      message?: string;
      raw: TerminationRaw;
    }
  // Network/transport error reaching the Anthropic API — typically a
  // mid-stream socket disconnect. SDK reports these as `subtype: 'success'`
  // with the error text leaked into `result`; classifyTermination's
  // `LEAKED_ERROR_PATTERNS` table promotes them here so the turn is
  // surfaced as failed (with a Retry CTA) rather than silently billed
  // as completed. See sdk-subtype-success-leaked-error memory note.
  | { kind: 'network_error'; message: string; raw: TerminationRaw }

  // ─── Escape hatch (future-proofing) ────────────────────────────────────
  | {
      kind: 'unknown';
      subtype: string;
      terminalReason?: string;
      errors: string[];
      raw: TerminationRaw;
    };

/** Discriminator values, for exhaustive switches and telemetry labels. */
export const TURN_OUTCOME_KINDS = [
  'completed',
  'refused',
  'deferred',
  'max_turns',
  'max_budget',
  'max_structured_output_retries',
  'user_aborted',
  'hook_blocked',
  'task_cap',
  'detached',
  'context_exceeded',
  'rate_limited',
  'image_error',
  'request_invalid',
  'model_error',
  'model_unavailable',
  'auth_error',
  'billing_error',
  'network_error',
  'unknown',
] as const;

export type TurnOutcomeKind = (typeof TURN_OUTCOME_KINDS)[number];

/**
 * Convenience helper — narrow an outcome to the ones that are real errors
 * (i.e. not `completed`, `refused`, or `deferred`). Frontend uses this to
 * decide whether to render any termination UI at all.
 */
export function isErrorOutcome(outcome: TurnOutcome): boolean {
  return (
    outcome.kind !== 'completed' &&
    outcome.kind !== 'refused' &&
    outcome.kind !== 'deferred'
  );
}

/**
 * Prompt-cache hit rate for a turn — a MEASUREMENT-ONLY SLI, changes no billing.
 * It is the dominant known TTFT lever (Fireworks TTFT ∝ uncached prefill; a deploy
 * wipes the cache). Ratio of cache-read tokens to the TOTAL prompt tokens (uncached
 * input + cache reads + cache creation — the three non-overlapping input buckets
 * `buildModelUsage` populates), summed across every model in the turn's usage.
 * Purely derived from `modelUsage`.
 *
 * Returns `undefined` when there is nothing to measure (no model entries) so the
 * caller omits the field → byte-identical wire. Guards divide-by-zero (0 when the
 * denominator is 0), clamps to [0,1], rounds to 4 decimals.
 */
export function cacheReadRatioFromModelUsage(
  modelUsage: ModelUsageSummary | undefined,
): number | undefined {
  const entries = modelUsage ? Object.values(modelUsage) : [];
  if (entries.length === 0) return undefined;
  let reads = 0;
  let totalPrompt = 0;
  for (const e of entries) {
    reads += e.cacheReadInputTokens;
    totalPrompt += e.inputTokens + e.cacheReadInputTokens + e.cacheCreationInputTokens;
  }
  if (totalPrompt <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, reads / totalPrompt));
  return Math.round(clamped * 10_000) / 10_000;
}

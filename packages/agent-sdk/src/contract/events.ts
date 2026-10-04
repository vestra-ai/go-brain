import type { ContentBlock } from './blocks.js';
import type { InteractionRequest } from './interaction.js';
import type { SubagentId, SubagentPathSegment } from './subagent-path.js';
import type { InitiativeTrigger, PolitenessPolicy } from './harness.js';
import type { ModelUsageSummary, TurnOutcome } from './turn-outcome.js';
// Type-only (erased) import — `child-cost.ts` imports `NormalizedUsage` from this
// file, so a VALUE import here would create a runtime cycle; `import type` does not.
import type { ChildCostRecord } from './child-cost.js';

/**
 * What kind of round a model request served — rides the per-round usage event
 * (wire: `round_kind`) so the server's [TTFT] observability can attribute a
 * request's latency to its cause instead of guessing from a turn-scoped clock:
 *  - 'fresh'        : the first round of a user turn (the user-perceived TTFT).
 *  - 'steer'        : the first round after a mid-turn steer landed (the old
 *                     turn-clock metric emitted negative components here).
 *  - 'continuation' : a subsequent tool-loop round within the same turn.
 */
export type RoundKind = 'fresh' | 'steer' | 'continuation';

/**
 * Which model call a usage event accounts for — rides the per-round usage event
 * (wire: `lane`). The harness makes THREE kinds of provider call per turn, and
 * until this tag existed only the first was ever metered:
 *  - 'main'       : a tool-loop round of the live turn (the billed path).
 *  - 'sweep'      : the Nami off-loop memory sweep — a full-context side call
 *                   (system + tools + the whole journal projection) fired after
 *                   a completed turn.
 *  - 'suggestion' : the next-prompt chip's small side call (last user+assistant
 *                   pair, 128 max tokens).
 *  - 'compaction' : the summarize call that produces a compaction summary
 *                   (COMPACTION_V2).
 *
 * The two SIDE calls previously DISCARDED their usage as absorbed product cost, so
 * they appeared in no cost table and no dashboard. Tagging them puts them on the
 * books without changing what is billed: metering is not charging (see the
 * server's BILL_OFFLOOP_V1 gate, default OFF).
 *
 * 'compaction' is NOT one of those side lanes, and the difference is load-bearing.
 * Its cost is already folded into `cumulativeCostUsd` and charged through the
 * turn's claimed total, but it emitted NO usage message at all — so the server's
 * re-priced total (turn-reprice.service.ts, a per-message sum held BESIDE the
 * claimed one) was silently short by every summarize call ever made. Tagging it
 * closes that gap: the lane belongs OUT of `isOffloopLane` so the message is
 * repriced like any main-rail cost, and the two billing legs finally agree.
 *
 * 'subagent' (C5, SUBAGENT_USAGE_LEDGER_V1) is the same story for an in-process
 * subagent's rounds: their cost rides the parent turn's claimed total through the
 * Agent tool, but no usage message ever left the nested loop, so the re-priced total
 * was short by exactly the children's cost (prod, 7 days to 2026-10-02: every one of
 * 13 subagent turns, server = claimed - child cost to the micro-dollar) and the
 * ledger had no row for those calls. Out of `isOffloopLane` like 'compaction'.
 *
 * 'post_turn_compaction' (COMPACTION_POST_TURN_V1) is a summarize that ran AFTER its turn
 * ended, in the idle wait for the next message, so no turn's claimed total carries it: it is
 * an off-loop lane, in `isOffloopLane` beside 'sweep', metered and charged on its own leg.
 *
 * 'main' is left IMPLICIT — the main loop omits the field entirely so its wire
 * shape and its DB row stay byte-identical to the pre-lane rail.
 */
export type UsageLane = 'main' | 'sweep' | 'suggestion' | 'compaction' | 'vision' | 'subagent' | 'post_turn_compaction';

/**
 * COMPACTION_POST_TURN_V1 — what a compaction did, carried on its usage event so the O1 rail
 * (one PostHog event per model call) can say why it ran and what it saved. `reason`:
 * 'round_head' the economic trigger before a round, 'post_turn' after a turn ended,
 * 'recovery' an overflow self-heal, 'manual' a /compact. `strategy`: 'local' our own
 * summarize ('remote', a provider's server-side compaction, is not built). Token counts are
 * the journal's own before and after figures for the spliced span.
 */
export interface CompactionInfo {
  reason: 'round_head' | 'post_turn' | 'recovery' | 'manual';
  strategy: 'local' | 'remote';
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * How the model call behind a usage event ended. 'error': it failed or timed out, reporting
 * ZERO usage, so without this marker a failed sweep is indistinguishable from a sweep that never
 * ran. 'ok': it returned. The memory sweep says more (memory-sweep.ts sweepOutcome): 'ok' at
 * least one fact, 'none' the model said NONE, 'capped' the output cap cut it, 'empty' neither.
 * 'cancelled' (POST_TURN_OFF_PATH_V1): the call was SENT and then cut on purpose, because the
 * person's next message arrived first. It is real provider spend, not a failure: the row carries
 * whatever usage the provider reported before the cut (zero when it reported none, which is the
 * common case: usage arrives with `done`), so the drift is countable as its own status.
 * 'timeout' (SWEEP_PREFIX_PARITY_V1): a memory sweep riding the loop's request ran into its own
 * 30 s bound. Real spend, never zero by design: the row carries the usage the provider reported,
 * else the engine's estimate (memory-sweep.ts estimateSweepSpend). On that path a 'cancelled'
 * row carries the same estimate when the provider reported nothing.
 */
export type UsageLaneStatus = 'ok' | 'error' | 'none' | 'capped' | 'empty' | 'cancelled' | 'timeout';

/** One instruction layer's raw text size (chars). Tokens ≈ chars/4. */
export interface PromptLayerSize {
  id: string;
  chars: number;
}

/**
 * Per-fresh-request prompt-payload breakdown (observability only). Answers "what
 * is the ~40k unattributed prefill on a fresh native task made of?" by measuring
 * the SERVED bytes at the model-call site: the assembled system prompt (total +
 * per instruction layer), the tool schemas (count, total, and the 5 largest), and
 * the first user-message envelope (any context blocks riding it). Chars, not
 * tokens (tokens ≈ chars/4); zero extra model calls; emitted once per task birth
 * on the AGENT_USAGE of the first fresh round. Never a billing field.
 */
export interface PromptBreakdown {
  /** chars of the full assembled system prompt (all layers + framing). */
  systemChars: number;
  /** per-instruction-layer raw text chars (soul, operational, situation, nami, …). */
  layers: PromptLayerSize[];
  /** number of tool schemas on the wire. */
  toolsCount: number;
  /** chars of the whole JSON tools array. */
  toolsChars: number;
  /** the 5 largest tool schemas, {name, chars}, descending. */
  topTools: { name: string; chars: number }[];
  /** chars of the first user-message envelope (JSON, incl. any context blocks). */
  msg0Chars: number;
}

/**
 * Harness-agnostic usage. Tokens are universal; cost/cache/reasoning are
 * optional because not every engine reports them (Claude reports cost +
 * cache; OpenAI reports tokens only and we derive cost). See spec §6.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * Anthropic's split of `cacheCreationInputTokens` by cache TTL (wire
   * `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`).
   * A 1-hour write bills 2x input against the 5-minute 1.25x, and the model proxy
   * writes every breakpoint at 1h — so the sink forwards these as the nested
   * `cache_creation` the server prices from. Absent on every non-Anthropic arm.
   */
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  reasoningTokens?: number;
  /**
   * Fugu/Sakana orchestration tokens (summed orchestration_* fields). Populated
   * by normalizeUsage on the Sakana path; carried to the engine NormalizedUsage
   * at the cost boundary so computeFuguCostUsd can bill it. Absent elsewhere.
   */
  orchestrationTokens?: number;
  /**
   * §4.9 — Fugu orchestration usage broken out by category (multi-agent
   * orchestration usage reported discretely by Fugu Ultra). DATA-5 attribution
   * twins of the summed `orchestrationTokens`: the same Sakana-path normalizeUsage
   * parse sets all four; the summed field feeds the cost term (computeFuguCostUsd),
   * while these three ride snake_case on the AGENT_USAGE wire (DATA-7) into the
   * task_turn_usage orchestration_* columns for attribution/visibility. Each is
   * OPTIONAL/additive: every non-Fugu provider leaves them undefined ⇒
   * byte-identical (the columns stay NULL).
   */
  orchestrationInputTokens?: number;
  orchestrationInputCachedTokens?: number;
  orchestrationOutputTokens?: number;
  /** Present iff the arm's capabilities.reportsCostUsd is true. */
  costUsd?: number;
  model?: string;
}

/**
 * K4F-1 — a flat context-window-fullness snapshot. The 4 REQUIRED fields are the
 * exact shape the web ContextMeter consumes off AGENT_CONTEXT_USAGE
 * (`{ totalTokens, maxTokens, percentage, model }`). The 4 OPTIONAL per-category
 * buckets are ADDITIVE — the web pass-through ignores them today; they ride along
 * for a future per-category drill-down. Defined here (NOT imported from the
 * product `@bash/shared`) so the SDK contract stays self-contained: `@bash/shared`
 * depends on the SDK, never the reverse. The sink maps this onto the product
 * AgentContextUsagePayload at the socket boundary.
 */
export interface ContextUsageSnapshot {
  /** Total tokens currently occupying the context window. */
  totalTokens: number;
  /** Effective max context for the active model. */
  maxTokens: number;
  /** Pre-computed percentage (0-100). */
  percentage: number;
  /** Active model id (e.g. 'claude-sonnet-4-6'). */
  model: string;
  /** OPTIONAL per-category breakdown (additive; the flat totals are authoritative). */
  system?: number;
  tools?: number;
  messages?: number;
  memory?: number;
}

/**
 * HarnessEvent — what every arm's run() yields. An OPEN discriminated union:
 *  - 'block'       : any of the 14 shared ContentBlock types (+ future ones)
 *  - 'usage'       : per-turn token/cost accounting
 *  - 'interaction' : feeds the existing INTERACTION_REQUIRED pipeline (pause-for-human)
 *  - 'turn_end'    : a completed turn — the harness-agnostic TurnOutcome plus the
 *                    turn-completion payload a consumer needs to finalize the turn
 *                    (blocks, stopReason gate, and the rewind/resume message id).
 *  - 'hook'        : K6-P2 B4 — per-callback HOOK OBSERVABILITY. Emitted by the
 *                    sandbox-layer observer the kernel dispatcher calls around each
 *                    hook callback (started/completed/error/cancelled). Additive +
 *                    GATED (default OFF) — no producer yields it unless the
 *                    `includeHookEvents` flag wires the observer, so the arm is
 *                    byte-identical when unused. Mirrors the SDK's
 *                    SDKHook{Started,Progress,Response}.
 *  - 'raw'         : ESCAPE HATCH — engine-specific output an engine-specific
 *                    renderer handles, so a NEW engine's novel feature needs
 *                    NO interface change (spec §2 governing rule).
 */
export type HarnessEvent =
  | { kind: 'block'; block: ContentBlock }
  /**
   * A thinking/reasoning block has OPENED. The native engine yields ONE of these
   * the moment the provider starts a thinking block (Anthropic `content_block_start`
   * type=thinking; OpenAI the reasoning output item), BEFORE the first thinking
   * fragment. The sink maps it onto AGENT_THINKING_START so the web mounts the
   * thinking pill + running timer immediately, then streams AGENT_THINKING_DELTA
   * text into it — Anthropic's summarized adaptive thinking lags the block start by
   * seconds, so the first-fragment mount left the user staring at nothing. The
   * Claude arm keeps its OWN AGENT_THINKING_BLOCK_START path (sdk/processor.ts) →
   * no double-emit, Claude byte-identical. ADDITIVE: no producer yields it unless
   * the native loop runs.
   */
  | { kind: 'thinking_start' }
  | {
      /**
       * Per-round token/cost accounting. K4C-1: the native loop yields ONE of
       * these PER tool-loop round (each carrying THAT round's cache read/write),
       * so cache observability is per-API-call — matching the Claude arm, whose
       * processor emits one canonical AGENT_USAGE per `message_start`. The sink
       * builds the canonical nested snake_case AGENT_USAGE from this event.
       *
       * `messageId` / `turnNumber` are OPTIONAL + additive: an omitted usage event
       * is byte-identical to the pre-K4C-1 shape. When present:
       *   - `messageId`  → the wire `sdk_message_uuid` (per-round idempotency key;
       *                    the server skips the durable DB row without it).
       *   - `turnNumber` → the wire `turn_number` (per-round, monotonic per task).
       *   - `model`      → the wire `model` (the committed model for the round;
       *                    may also be carried on `usage.model`).
       *   - `ttftMs`     → the wire `ttft_ms` — THIS round's honest per-request
       *                    TTFT, measured at the model-call site (request start →
       *                    first stream event, single clock ⇒ never negative;
       *                    includes transparent retry backoff). Rides the usage
       *                    event so the server can log it NEXT TO the round's
       *                    cache read/prefill — a turn-scoped clock was a bent
       *                    ruler (a mid-turn steer re-anchored it into negative
       *                    components).
       *   - `latencyMs`  → the wire `latency_ms` — THIS round's whole model call,
       *                    request start → its last stream event, on the same
       *                    clock as `ttftMs` (so latencyMs ≥ ttftMs). Read by the
       *                    per-call PostHog event (MODEL_CALL_EVENTS_V1). A side
       *                    call (sweep, suggestion) carries it too: its wall time.
       *   - `firstTextMs` → the wire `first_text_ms` — request start → the first
       *                    answer text the person sees (thinking and tool calls
       *                    are not text), same clock. Absent on a round that
       *                    wrote no text.
       *   - `beforeSendMs` / `afterSendMs` → the wire `before_send_ms` /
       *                    `after_send_ms` — `latencyMs` split at the moment the
       *                    committed attempt was handed to the transport, named for
       *                    WHEN, not whose: before it, the request build, every
       *                    failed attempt (provider 429 / 529 / 5xx answers too)
       *                    and the waits between; after it, the transport's wire
       *                    prep (a lazy upload, image inlining), the network, the
       *                    provider and our drain. beforeSendMs + afterSendMs =
       *                    latencyMs.
       *   - `attempts`   → the wire `attempts` — how many attempts this round sent
       *                    (1 when the first one committed).
       *   - `roundKind`  → the wire `round_kind` — what kind of round this
       *                    request served: 'fresh' (first round of a user turn),
       *                    'steer' (first round after a mid-turn steer landed),
       *                    'continuation' (subsequent tool-loop round).
       */
      kind: 'usage';
      usage: NormalizedUsage;
      messageId?: string;
      turnNumber?: number;
      model?: string;
      ttftMs?: number;
      latencyMs?: number;
      firstTextMs?: number;
      beforeSendMs?: number;
      afterSendMs?: number;
      attempts?: number;
      roundKind?: RoundKind;
      /**
       * Which model call this accounts for → the wire `lane`. Present ONLY on
       * the off-loop side calls ('sweep' / 'suggestion'); the main loop omits it
       * so every main-lane event stays byte-identical. See {@link UsageLane}.
       */
      lane?: UsageLane;
      /**
       * Whether that call returned → the wire `lane_status`. Rides WITH `lane`
       * (never alone): an 'error' event carries zero tokens on purpose, so the
       * failed call is a visible row instead of a silent gap.
       */
      laneStatus?: UsageLaneStatus;
      /** COMPACTION_POST_TURN_V1: on a compaction lane's event only → the wire `compaction`. */
      compaction?: CompactionInfo;
      /**
       * Media-refs S0 metering — serialized request size + wire image count/bytes
       * for THIS round's model call (request-meter.ts). Optional + additive:
       * absent ⇒ the prior event shape, byte-identical.
       */
      requestMeta?: { requestBytes: number; imageCount: number; imageBytes: number };
      /**
       * OPTIONAL per-fresh-request payload breakdown → the wire `prompt_breakdown`.
       * The engine builds it ONCE per task birth (the first 'fresh' round) so the
       * server's [prompt-span] line can attribute the fresh prefill by layer/tool.
       * Absent on every other round ⇒ byte-identical to the pre-span shape.
       */
      promptBreakdown?: PromptBreakdown;
      /**
       * The model whose PRICE this round bills at when it differs from `model` →
       * the wire `billed_as`. Present ONLY on a round the engine served on the
       * picked model's `unavailableSibling` after the picked lane answered "model
       * not found": `model` is the served sibling (the usage row's truth),
       * `billedAs` the picked model (what the person is charged). Absent on every
       * other round ⇒ byte-identical.
       */
      billedAs?: string;
    }
  | {
      /**
       * K4F-1: a per-turn context-window-fullness snapshot. The native arm yields
       * ONE of these per user turn (computed at the turn boundary from the
       * projected journal + system + tool-schema), and the sink maps it onto
       * EVENTS.AGENT_CONTEXT_USAGE — giving native runs the same context meter the
       * Claude arm gets via its SDK getContextUsage() path. ADDITIVE: no producer
       * yields it unless the native loop runs (gated by the native runtime), and
       * the Claude arm keeps its OWN emitContextUsage path → no double-emit,
       * Claude byte-identical.
       */
      kind: 'context_usage';
      snapshot: ContextUsageSnapshot;
    }
  | {
      kind: 'interaction';
      request: InteractionRequest;
      /**
       * T3 (subagent-deep-HITL) — OPTIONAL subagent identity for the leaf that
       * paused (depth ≥ 1). The sink rides them onto INTERACTION_REQUIRED (full
       * path) + SESSION_STATE_CHANGED (`subagentId` only, for lane scoping). Both
       * absent ⇒ a main-agent pause ⇒ the emitted payloads are byte-identical to
       * today. Inert until a later task populates them.
       */
      subagentId?: SubagentId;
      subagentPath?: SubagentPathSegment[];
    }
  | {
      kind: 'turn_end';
      outcome: TurnOutcome;
      /**
       * Assistant content blocks produced during this turn. Optional because a
       * harness MAY surface blocks only via 'block' events; the Claude arm
       * bundles them here too (the onTurnComplete blocks) so the consumer can
       * finalize the turn without re-accumulating.
       */
      blocks?: ContentBlock[];
      /**
       * Engine stop reason for the turn ('end_turn' | 'tool_use' | 'max_tokens'
       * | null | …). Consumers gate turn-final actions on this (e.g. don't end
       * the UI turn on an intermediate 'tool_use' round).
       */
      stopReason?: string | null;
      /**
       * Stable id of the assistant message for this turn — the rewind/resume
       * pivot. Claude populates from the SDK message uuid; other engines from
       * their own per-message id. Absent when the engine has no such id.
       */
      messageId?: string;
      /**
       * Named reason this turn ended, stamped at the break site (debug + analytics).
       */
      exitReason?: string;
      /**
       * TRUE iff this turn ended because the agent PAUSED for human input (a HITL
       * gate: AskUserQuestion / tool_permission / composio_auth / a sub-agent's
       * inner pause). A paused turn_end is a SUSPENSION, not a completion: the
       * binding interaction is still pending and the run resumes on resolve.
       * Consumers MUST NOT treat it as "the run abandoned its blocks" — e.g. the
       * server turn-end orphan sweep skips it (else it cancels the very
       * interaction the turn paused on). Absent (not false) on a normal
       * completion → byte-identical wire shape for non-paused turns.
       */
      paused?: boolean;
      /**
       * P4 — present IFF this turn was self-initiated (`origin.kind === 'initiative'`).
       * Derived from the turn's `UserTurn.origin` and stamped on the terminal turn_end.
       * The engine's contract ends here: "an initiative result, classified". Delivery
       * (panel/toast/voice) is product-plane, downstream of this event. Absent (not a
       * false-y object) on every human/default turn → byte-identical wire shape (the
       * exitReason?/paused? additive-optional precedent).
       */
      initiative?: {
        trigger: InitiativeTrigger;
        politeness: PolitenessPolicy;
      };
      /**
       * Cumulative billing snapshot for arms that bill THROUGH the event stream
       * (`capabilities.reportsCostUsd === false` → the SDK reports no dollar
       * cost, so the harness derives it and surfaces the running total here).
       * Present on EVERY turn_end from such an arm; ABSENT for arms whose SDK
       * reports cost via its own result message (Claude → its processor emits
       * AGENT_RESULT, so the core must NOT — else it double-bills).
       *
       * This is the LEAK-1 de-leak seam: cost flows to the core via the EVENT,
       * never off the harness instance, so the driver bills without an
       * `instanceof`/runtime branch.
       *
       * `cumulativeCostUsd` MUST be cumulative across the whole conversation
       * (never per-turn): the server ledger delta-deducts max(0, new − last)
       * per turn. For per-turn cost see `outcome.costUsd` (completed turns).
       */
      billing?: {
        cumulativeCostUsd: number;
        modelUsage?: ModelUsageSummary;
        /**
         * Agent v2 (Task 4) — the per-turn cost DELTA the server actually charges:
         * `cumulativeCostUsd_end − cumulativeCostUsd_turnStart`. Because
         * `cumulativeCostUsd` is run-monotonic across every warm turn, the delta is
         * the right per-turn-row charge. Optional + additive (absent on arms that
         * don't surface it → byte-identical).
         */
        turnDeltaUsd?: number;
        /**
         * P2.1 (Task 5) — the journal-derived cost seed this run was reconstructed
         * from, carried onto the wire so the server can tell a SEEDED resume from a
         * genuine query restart. Set ONLY when the product plane seeded the run's
         * cumulative from the journal's settled rounds (mirrors `NativeConfig.
         * journalSeedUsd`); NEVER by the subagent re_execute replay-cost path. The
         * server suppresses its restart-branch reset-to-0 when this is > 0, so a
         * resumed cumulative that lands BELOW the durable baseline is not re-billed.
         * Optional + additive (absent on cold/warm/non-seeded turns → byte-identical).
         */
        journalSeedUsd?: number;
        /**
         * Agent v2 (Task 4) — the parent's OWN model cost for THIS turn, measured
         * INDEPENDENTLY at the parent's model rounds (+ compaction), NEVER derived as
         * `turnDeltaUsd − Σ(childUsage)`. With `childUsage` this reconciles the turn:
         * `parentOwnCostUsd + Σ(childUsage.costUsd) === turnDeltaUsd`. A derived value
         * would make that invariant a tautology that cannot detect a child mis-count.
         */
        parentOwnCostUsd?: number;
        /**
         * Agent v2 (Task 4) — the attributed per-child cost records emitted via
         * `ctx.addChildCost` during THIS turn (RESET at each user-turn boundary, so a
         * later warm turn never re-reports an earlier turn's children against a
         * delta-charged row).
         */
        childUsage?: ChildCostRecord[];
      };
    }
  | { kind: 'session_state_changed'; state: 'idle' | 'running' | 'requires_action' }
  | {
      /**
       * K6-P2 B4 — HOOK OBSERVABILITY. One per phase transition of a single hook
       * callback invocation. ADDITIVE/OPTIONAL: every field beyond the discriminant
       * is either always-present-by-construction (hookId/hookEvent/phase) or
       * optional, so omitting the whole kind is byte-identical (no producer yields
       * it unless the gated observer is wired).
       */
      kind: 'hook';
      /** Stable id correlating this callback invocation's started↔terminal phases. */
      hookId: string;
      /** The HookEvent the callback is registered on (e.g. 'PreToolUse'). */
      hookEvent: string;
      /** Friendly callback name, when known (e.g. 'screenshot-prune'). */
      hookName?: string;
      /** The group's matcher regex, when the group declared one. */
      matcher?: string;
      /** Lifecycle phase of the callback invocation. */
      phase: 'started' | 'completed' | 'error' | 'cancelled';
      /** Wall-clock duration; STAMPED BY THE HOST observer, never the kernel. */
      durationMs?: number;
      /** Error message when `phase === 'error'`. */
      error?: string;
      /** Future shell-hook stdout parity (unused by JS callbacks today). */
      stdout?: string;
      /** Future shell-hook stderr parity (unused by JS callbacks today). */
      stderr?: string;
    }
  /**
   * ESCAPE HATCH — engine-specific event forwarded opaquely. `event` is a
   * string (not EventName) so the SDK contract stays free of Vestra's
   * product socket-event vocabulary. All producers pass EVENTS.* constants
   * (which are strings); the sole consumer compares with === against the same
   * constant — both remain valid against `string`.
   */
  | { kind: 'raw'; engine: string; event: string; data: unknown };

export function isBlockEvent(
  e: HarnessEvent,
): e is Extract<HarnessEvent, { kind: 'block' }> {
  return e.kind === 'block';
}

export function isRawEvent(
  e: HarnessEvent,
): e is Extract<HarnessEvent, { kind: 'raw' }> {
  return e.kind === 'raw';
}

export function isHookEvent(
  e: HarnessEvent,
): e is Extract<HarnessEvent, { kind: 'hook' }> {
  return e.kind === 'hook';
}

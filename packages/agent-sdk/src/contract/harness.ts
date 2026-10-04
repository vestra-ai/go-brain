import type { ContentBlock, ImageBlock, MediaBlock } from './blocks.js';
import type { TurnOutcome } from './turn-outcome.js';
import type { HarnessId } from './ids.js';
import type { HarnessCapabilities } from './capabilities.js';
import type { HarnessEvent, NormalizedUsage } from './events.js';
import type { PermissionUpdate } from './permission.js';
import type { InteractionKind, InteractionOutcome } from './interaction.js';

// =============================================================================
// K6 A0 — message envelope extension types
// =============================================================================

/**
 * Queue lane for a staged message.
 * `now`   = steer at the next safe boundary (highest priority).
 * `next`  = normal turn boundary, FIFO (default when omitted).
 * `later` = back of the queue (lowest priority).
 * Lanes are ranked now < next < later; FIFO within a lane.
 */
export type MessagePriority = 'now' | 'next' | 'later';

/**
 * P4 — why a self-initiated (`initiative`) turn fired. A discriminated union so an
 * illegal combination is unrepresentable: a trigger can ONLY exist on an initiative
 * origin. P5's Nami surprise constructs the `context` variant.
 */
export type InitiativeTrigger =
  | { kind: 'scheduled'; scheduleId: string; firedAt: string } // cron/at — "check the deploy at 5pm"
  | { kind: 'signal'; source: string; eventId?: string } // inbound channel/webhook/app event
  | { kind: 'context'; reason: string; score?: number }; // a threshold the context engine raised

/**
 * P4 — how loudly an initiative RESULT may surface. Gates CONSEQUENCES (whether the
 * result reaches the user), never the command itself.
 */
export type PolitenessPolicy = 'may-notify' | 'silent-unless-actionable' | 'draft-only';

/**
 * Provenance of a user turn — identifies the source that authored the message.
 * `human`             = typed directly by the user in the composer.
 * `channel`           = injected via a channel integration (Slack, email, etc.).
 * `peer`              = forwarded from another agent (multi-agent scenario).
 * `auto-continuation` = system-generated (e.g. [SYSTEM_RESUME], prewarm ping).
 * `initiative`        = P4 — the agent acting on its OWN initiative (a schedule
 *                       fired, an inbound signal, or the context engine crossing a
 *                       threshold). Carries WHY it fired (`trigger`) and how loudly
 *                       its RESULT may surface (`politeness`).
 *
 * A discriminated union: the four legacy kinds are exactly today's shape (byte-
 * identical), and `trigger`/`politeness` exist ONLY on the initiative variant.
 */
export type MessageOrigin =
  | {
      kind: 'human' | 'channel' | 'peer' | 'auto-continuation';
      /**
       * P5.1 (Agent Teams) — attribution of the peer that forwarded this turn.
       * Meaningful only for kind:'peer' (a lead↔teammate message); additive-
       * optional, so absent ⇒ byte-identical to the pre-teams shape.
       */
      peerName?: string;
      peerTaskId?: string;
      /**
       * Orchestration Phase 3 (spec §4.5) — helper-to-helper loop guard.
       * Meaningful only for kind:'peer': the number of helper-to-helper hops in
       * the chain that produced this message. Absent or 0 means the message was
       * sent by the lead or by a person, so the chain starts here. A helper's
       * own SendMessage increments it and refuses to send past 6, which is what
       * stops two helpers messaging each other forever. Additive-optional, so
       * absent is byte-identical to the pre-Phase-3 shape.
       */
      hop?: number;
    }
  | { kind: 'initiative'; trigger: InitiativeTrigger; politeness: PolitenessPolicy };

/** A user (or system-continuation) turn fed into the loop. */
export interface UserTurn {
  text: string;
  /**
   * Images uploaded with this turn, as first-class content blocks. Each carries
   * EITHER a CDN `url` (preferred — avoids the 20MB base64 request cap) OR inline
   * base64 `data`. The native-family arms journal these alongside the text and
   * replay them to the model as image content blocks (so the model actually SEES
   * the upload). The Claude arm does NOT read this — it carries images on the raw
   * SDKUserMessage content straight to the vendored subprocess.
   */
  images?: ImageBlock[];
  /**
   * VIDEO_UNDERSTANDING_V1 — video / audio / PDF attached to this turn, as
   * POINTER blocks (the `files/<name>` path the message names, the signed
   * download url, the hash). Never bytes. The native-family arms journal them
   * beside the text; only the Gemini projection puts them on the wire — every
   * other dialect ignores them, so its request is byte-identical to today.
   */
  media?: MediaBlock[];
  /** True for internal continuations (e.g. [SYSTEM_RESUME]); not user-authored. */
  system?: boolean;
  /**
   * K5 HITL continue signal (D-Sink). When true, run() drives ONE iterate off the
   * now-complete journal projection WITHOUT appending a user entry — materializing
   * a resolved interaction's tool_result IN PLACE (no synthetic user turn, no
   * auto-query). `text` is ignored for a continue turn. The continue inherits the
   * SAME terminal turn_end + re-pause-break path as a normal turn, so a re-pause
   * inside a continue finalizes identically.
   */
  continueInteraction?: boolean;
  /**
   * The resolution a continue turn carries (spec 2026-09-28 §6.4). A CLI engine owns its
   * own transcript, so there is no journal slot to materialize the answer into: it renders
   * this as its NEXT turn's text instead (engines/cli-common/park.ts renderContinuation).
   * The native arm reads the journal and ignores it. Absent on every other turn.
   */
  interaction?: { kind: InteractionKind; outcome: InteractionOutcome };
  /**
   * The account slot a CLI engine runs this turn on (several accounts, spec 2026-10-01): the
   * server's pick, carried from USER_MESSAGE.engineSlotId. Claude Code resolves its config dir
   * from it per turn. Absent = 'primary', today's one account; native ignores it.
   */
  engineSlotId?: string;

  // ── K6 A0 envelope fields ──────────────────────────────────────────────────
  /**
   * Stable client-minted id. The idempotent join key for staging, cancel-by-uuid,
   * MESSAGE_PICKED_UP reconciliation, and reconnect-resync.
   * All arms are byte-identical when this is absent.
   */
  uuid?: string;
  /**
   * Queue lane. `now` steers at the next safe boundary; `next` (default) is
   * the normal turn boundary; `later` is the back of the queue.
   */
  priority?: MessagePriority;
  /**
   * When `false`, the text is appended to context WITHOUT starting an assistant
   * turn (staging-only mode). The message merges into the next querying turn.
   * Defaults to `true` (normal: query immediately).
   */
  shouldQuery?: boolean;
  /**
   * Provenance of the message. Identifies the source that authored this turn.
   */
  origin?: MessageOrigin;
  /**
   * BUILT-IN CONTROL turn. When set, the loop runs a CONTROL-plane op at the turn
   * boundary INSTEAD of driving a model turn. `compact` forces an immediate manual
   * compaction (the user-driven `/compact`) on a WARM run — routed THROUGH the loop
   * (which OWNS the journal) so the splice is inherently serialized with the loop's
   * own writes (no single-writer race). `memory` (Nami P1 hot end-of-task memory
   * pass) is a PROVENANCE marker only: the loop drives it as a normal querying
   * model turn (no engine special-case); the product driver owns its invisibility
   * and tool restriction. Absent → a normal querying turn (byte-identical).
   * Native-family arms only — the Claude arm never receives it (envelopeForArm
   * strips behavior-changing fields for Claude).
   */
  control?: 'compact' | 'memory';
}

/** Per-session context handed to run(). Generic over the arm's own config. */
export interface HarnessContext<TConfig = unknown> {
  taskId: string;
  sessionId: string;
  cwd: string;
  model: string;
  /**
   * P3 — REQUIRED abort signal for this run. Wired unconditionally by query()
   * and by the product driver, so interrupt() can never silently no-op. Arms
   * that cancel via their own out-of-band handle (Claude SDK) MAY ignore it for
   * stream teardown but MUST NOT contradict it (an aborted ctx.signal with a
   * still-running turn is a contract violation the suite asserts against for
   * native-family arms).
   */
  signal: AbortSignal;
  /** Arm-specific knobs (the typed escape hatch for driving differences). */
  config: TConfig;
}

/** A tool invocation the harness wants to run. */
export interface ToolCall {
  toolName: string;
  toolInput: unknown;
  /** Harness-minted correlation id (Anthropic tool_use_id, or a UUID we mint for OpenAI). */
  toolCallId: string;
}

/**
 * Gate decision for a tool.  `'needs_human'` routes into the interaction
 * pipeline.
 *
 * K6 P3 C0: the `allow` branch is WIDENED (additive/optional) to carry
 * `updatedPermissions?` — a list of rule mutations the gate wants the kernel
 * to apply (e.g. "remember this allow for the session").  Existing consumers
 * that produce `{ decision: 'allow' }` or `{ decision: 'allow', updatedInput }`
 * are unaffected: both shapes still satisfy the union.
 */
export type GateResult =
  | {
      decision: 'allow';
      updatedInput?: unknown;
      /**
       * Optional permission mutations to apply after this gate decision.
       * P3 uses this to persist a user-approved rule to `session` or
       * `localSettings` without requiring the caller to know the destination.
       * Absence means "no rule change" (byte-identical to pre-K6 behavior).
       */
      updatedPermissions?: PermissionUpdate[];
    }
  | {
      decision: 'deny';
      message: string;
      /**
       * K6-P3-C7: which ladder stage produced this deny — pure OBSERVABILITY,
       * carried to the FE on the PERMISSION_DENIED event so a "denied" card can
       * classify the reason. ADDITIVE/OPTIONAL: absent on any pre-C7 deny, so
       * every existing `{ decision: 'deny', message }` still satisfies the union.
       *   - `'security'`   — dangerous Bash / sensitive-file write (security gate).
       *   - `'capability'` — plan-gated tool whose capability is not granted.
       *   - `'rule'`       — a matching deny permission rule.
       *   - `'mode'`       — a mode-driven hard deny (dontAsk turning ask/floor
       *                      into deny; plan-mode write block).
       *   - `'floor'`      — reserved for a sensitivity-floor hard deny (today the
       *                      floor's deny path is dontAsk, stamped `'mode'`).
       *   - `'delivery'`   — the deliver-guard blocked a duplicate outbound
       *                      delivery (or an expiring signed URL in one) —
       *                      policy/deliver-ledger.ts, incident 832d60fd.
       *   - `'own_chat'`   — a write as the owner into the chat Bash answers
       *                      this task in — policy/bash-chats.ts (2026-10-03).
       */
      reasonType?: 'security' | 'capability' | 'rule' | 'mode' | 'floor' | 'delivery' | 'own_chat';
    }
  | {
      decision: 'needs_human';
      interactionKind: string;
      /**
       * X1: set on an ask no standing allow rule can silence (a person's ask rule, the
       * hard floor: payments and dangerous deletes). A hook answering a permission
       * card on the person's behalf (PermissionRequest) may only silence a card an
       * allow rule could, so it never answers these. Absent = an ordinary ask.
       */
      unsilenceable?: true;
    };

/**
 * Opaque handle to a paused tool call. `serializable` reflects the arm's
 * capabilities.resumeSurvivesRestart: when true, `payload` is a JSON string
 * that can be persisted (substrate row) and revived in another process
 * (OpenAI RunState). When false, the pause is in-process only (Claude).
 */
export interface ResumeHandle {
  serializable: boolean;
  payload: string | null;
}

/** The human's out-of-band answer to a paused tool call. */
export interface HumanAnswer {
  decision: 'approve' | 'reject';
  message?: string;
  /** Only honored by arms with capabilities.inlineToolArgRewrite. */
  updatedInput?: unknown;
}

/**
 * Harness — THE SPINE. Every engine (Claude, OpenAI, future) implements this
 * identically. The contract standardizes how the core DRIVES the loop; what the
 * agent can DO lives in `capabilities` (per arm) + the open HarnessEvent union.
 * Generic over TConfig so an arm carries engine-specific driving knobs without
 * widening the shared methods.
 *
 * ── THE CONTRACT — guaranteed by a conformant arm, ENFORCED today by the
 *    cross-arm conformance suite (apps/sandbox/src/harness/__tests__/
 *    harness-conformance{,.claude}.test.ts → conformance-contracts.ts) and the
 *    anti-arm-branch lint (driver-arm-agnostic.lint.test.ts):
 *
 *  1. run() yields EXACTLY ONE terminal `turn_end` per completed turn, carrying
 *     a well-formed TurnOutcome — never zero (no "hang on processing"), never
 *     two (no double-finalize).
 *  2. Cost reaches the core ONLY via the event stream — `turn_end.billing`
 *     (CUMULATIVE) for arms whose SDK reports no dollar cost
 *     (`capabilities.reportsCostUsd === false`). The core never reads cost off
 *     the instance; cost-reporting arms bill via their own processor and omit
 *     `turn_end.billing` (so the core never double-bills).
 *  3. Assistant content reaches the core via the event stream — `block` events
 *     and/or `turn_end.blocks`, with `recoverAssistantBlocks?()` as the
 *     no-terminal-turn_end fallback. The core never reaches into arm-private
 *     buffers.
 *  4. The core selects arms by `id` (the construction factory) and branches only
 *     on `capabilities` + event data — NEVER `instanceof`/runtime strings
 *     (lint-enforced in the driver).
 *  5. Cancellation (native-family arms): `ctx.signal.aborted` ⇒ exactly one
 *     `user_aborted` turn_end within the drain bound — even mid-tool — and the
 *     in-flight tool result is sealed truthfully in the journal (an aborted signal
 *     never leaves a turn hanging). Arms that cancel via their own out-of-band
 *     handle (the Claude SDK) tear down through that handle and are exempt from the
 *     drain assertion, but MUST NOT contradict an aborted ctx.signal. Enforced by
 *     `assertInterruptObserved` + `assertBoundedDrain` in the conformance suite;
 *     the bounded-drain half is carried as an expected-red placeholder until P3's
 *     main-loop drain bound lands.
 *
 * ── DIRECTION OF TRAVEL — NOT yet uniform; do not rely on these as invariants:
 *  - never-throw: the OpenAI arm converts every engine error into a terminal
 *    error `turn_end` (run() never throws). The Claude arm may still throw and
 *    rely on the core's handleQueryError to finalize. Goal: all arms
 *    finalize-not-throw.
 *  - socket/billing emission: arms still emit some sockets (AGENT_TEXT_DELTA,
 *    AGENT_TOOL_USE/RESULT) and the Claude processor bills directly. Goal: move
 *    socket + billing emission into the core so run() emits ONLY HarnessEvents.
 *  - gating: gateTool() is today invoked INSIDE each arm (canUseTool / tool
 *    wrappers). Goal: the core drives gating uniformly through gateTool().
 *
 * Spec: docs/superpowers/specs/2026-05-29-swappable-harness-architecture-design.md §4.3
 * Roadmap: docs/superpowers/specs/2026-06-06-harness-spine-implementation-roadmap.md
 */
export interface Harness<TConfig = unknown> {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;

  /**
   * Drive the loop; yield harness-agnostic HarnessEvents. MUST yield exactly one
   * terminal `turn_end` per completed turn (contract #1); non-cost-reporting
   * arms carry cumulative `turn_end.billing` (contract #2). See the interface
   * contract above for the full set of guarantees + the not-yet-uniform goals.
   */
  run(
    input: AsyncIterable<UserTurn>,
    ctx: HarnessContext<TConfig>,
  ): AsyncIterable<HarnessEvent>;

  /** Decide whether a tool may run (allow / deny / needs-human). */
  gateTool(call: ToolCall): Promise<GateResult>;

  /**
   * OPTIONAL (P2.4). Suspend a tool call for an out-of-band human decision, returning
   * a resume handle. Only an arm that resumes THROUGH such a handle implements this.
   * Every current arm instead pauses by halting the turn and resuming via the substrate
   * row + `[SYSTEM_RESUME]` re-injection (a UserTurn), so their `pause`/`resume` were
   * no-op stubs and NOTHING in the core calls them — the methods are optional so an arm
   * can omit the lie. An arm that ever needs serialized-handle resume adds them back.
   */
  pause?(call: ToolCall): ResumeHandle;

  /** OPTIONAL (P2.4). Deliver the human's answer to a `pause` handle and continue. Present
   *  only on arms that implement `pause`; see `pause` for why every current arm omits it. */
  resume?(handle: ResumeHandle, answer: HumanAnswer): void;

  /** Map the engine's raw termination into the shared TurnOutcome. */
  classifyTermination(raw: unknown): TurnOutcome;

  /** OPTIONAL arm capability — only engines that support it implement it. */
  forkSession?(): Harness<TConfig>;

  /**
   * OPTIONAL no-result recovery hook. When run()'s loop ends WITHOUT a terminal
   * turn_end having delivered the turn's blocks (stream closed / errored
   * mid-turn), the core calls this to recover any assistant content the arm
   * streamed but never bundled into a turn_end, so the final AGENT_END still
   * carries it. Arms that always emit a terminal turn_end — or keep no such
   * buffer — omit this; the core falls back to []. The core calls it
   * generically, so this stays out of `instanceof`/runtime branches.
   */
  recoverAssistantBlocks?(): ContentBlock[];
}

export type { NormalizedUsage };

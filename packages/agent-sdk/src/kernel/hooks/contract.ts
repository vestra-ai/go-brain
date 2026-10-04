/**
 * K6-P2 — the provider-neutral HOOK CONTRACT.
 *
 * Our OWN minimal hook contract (first-principles DNA), deliberately made
 * STRUCTURALLY BYTE-COMPATIBLE with the Claude Agent SDK hook shapes
 * (`apps/sandbox/hooks/types.ts`, claude-agent-sdk 0.3.177) so the 11 existing
 * SDK-typed callbacks (security, credit, capability, composio pre/post,
 * routine-detection, screenshot-prune, composio-failure, notification, stop,
 * pre/post-compact) are ASSIGNABLE to this `HookCallback` with ZERO rewrite when
 * they are ported in Task B5. That structural compatibility is PROVEN by a
 * type-level test (`__tests__/contract-compat.test.ts`) that registers an
 * SDK-shaped callback against this contract.
 *
 * KERNEL PURITY (hard rule): this module imports NOTHING but `@bash/shared`
 * types — no `@anthropic-ai/*`, no `openai`, no Blaxel, no socket/IO. The kernel
 * never reaches a provider. The structural compat above is achieved WITHOUT
 * importing the SDK: we replicate the shapes we care about and let TypeScript's
 * structural typing do the proving.
 *
 * The kernel's source of truth is the Journal, not a transcript file — so
 * `BaseHookInput` ADDS an opaque `journalRef` handle that the kernel hands to a
 * hook. It also KEEPS the SDK's `transcript_path: string` (required) so an
 * SDK-typed `HookCallback` — which declares its `input` requiring
 * `transcript_path` — stays assignable to this contract with ZERO rewrite (B5).
 * The kernel simply NEVER reads `transcript_path`; the native loop populates it
 * with a journalRef-derived placeholder. Dropping the field to optional would
 * break SDK-callback assignability under `exactOptionalPropertyTypes` (function
 * parameters are contravariant: the kernel input must be a SUBTYPE of the SDK
 * input, hence must carry the SDK's required fields). The compat test enforces
 * this both ways.
 */

import type { JournalEntry } from '../../contract/journal.js';

// =============================================================================
// HookEvent — the events we consume (clean extension path; do NOT hardcode the
// count anywhere). Mirrors the SDK's `HookEvent` string-literal union but scoped
// to the surfaces the Vestra kernel actually dispatches on.
// =============================================================================

/**
 * The hook events the kernel dispatches on. A subset of the SDK's larger union,
 * chosen to cover exactly the 11 existing callbacks plus the lifecycle seams the
 * native loop needs. Each member is also the discriminant on its input's
 * `hook_event_name` (SDK-compatible casing).
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Notification'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd';

// =============================================================================
// Inputs — provider-neutral, structurally a SUPERSET of the SDK inputs so an
// SDK-shaped input value is assignable here (B5 portability). Every event's
// input extends `BaseHookInput`.
// =============================================================================

/**
 * Reasoning-effort shape, mirrored from the SDK's `BaseHookInput.effort`.
 */
export interface HookEffort {
  level: string;
}

/**
 * Fields shared by every hook input.
 *
 * `journalRef` is an OPAQUE handle the kernel hands to a hook so it can reach the
 * durable journal WITHOUT the kernel exposing a file path. It REPLACES the SDK's
 * `transcript_path`. `transcript_path` itself is accepted (optional) only so an
 * SDK-typed input remains structurally assignable; the kernel ignores it.
 */
export interface BaseHookInput {
  session_id: string;
  /**
   * Opaque handle to the durable journal for this session — the kernel's source
   * of truth, REPLACING the SDK's file-on-disk transcript. A hook reaches the
   * journal through this, never through `transcript_path`. Optional so the native
   * loop can omit it for lifecycle events with no journal context yet.
   */
  journalRef?: unknown;
  cwd: string;
  /** Permission mode string (SDK shape: optional, free string). */
  permission_mode?: string;
  /** Present only when the hook fires from within a subagent. */
  agent_id?: string;
  /** Agent type name (e.g. "general-purpose"). */
  agent_type?: string;
  /** Reasoning effort applied to the current turn. */
  effort?: HookEffort;
  /**
   * SDK `transcript_path`. REQUIRED only to preserve structural assignability of
   * the SDK-typed callbacks (whose `input` declares it required) — see the file
   * header. The kernel NEVER reads it; the native loop sets a journalRef-derived
   * placeholder. The journal is reached via `journalRef`.
   */
  transcript_path: string;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

/**
 * X1 — the moment a permission card would show (Claude Code's PermissionRequest).
 * Same tool fields as PreToolUse but WITHOUT `tool_use_id`, as documented. Fired by
 * the native tool dispatcher behind HOOK_PARITY_V1.
 */
export interface PermissionRequestHookInput extends BaseHookInput {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: unknown;
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
  duration_ms?: number;
}

export interface PostToolUseFailureHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

export interface PostToolBatchToolCall {
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  tool_response?: unknown;
}

export interface PostToolBatchHookInput extends BaseHookInput {
  hook_event_name: 'PostToolBatch';
  tool_calls: PostToolBatchToolCall[];
}

export interface NotificationHookInput extends BaseHookInput {
  hook_event_name: 'Notification';
  message: string;
  title?: string;
  notification_type: string;
}

export interface StopHookInput extends BaseHookInput {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message?: string;
}

export interface SubagentStartHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
}

/** How a subagent ended — the outcome the parent's SubagentStop observer reads.
 *  `paused` — a tool INSIDE the child suspended for a human-in-the-loop interaction;
 *  the child did not fail, it is WAITING (the parent turn resumes on resolve).
 *  `stopped` — the user stopped the child (orchestration walls); it returns a labelled
 *  partial rather than throwing, so it is neither `completed` nor an error.
 *  `refused` — a wall turned the spawn away; the child NEVER ran, so an observer must
 *  not read `completed` for work that never happened. */
export type SubagentStopStatus =
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'error'
  | 'paused'
  | 'stopped'
  | 'refused';

export interface SubagentStopHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_type: string;
  last_assistant_message?: string;
  /**
   * K6-P2 B3b — Vestra-kernel additions (Hermes-style), carried by the native
   * subagent runner so a parent/ability hook can react to HOW the child ended.
   * Optional so an SDK-typed callback (which never sets them) stays assignable.
   * `duration_ms` is stamped by the sandbox HOST (the Agent tool), never by the
   * kernel — the kernel only carries the number.
   */
  status?: SubagentStopStatus;
  duration_ms?: number;
  /** A short result/summary of the child run, when readily available. */
  child_summary?: string;
}

export interface PreCompactHookInput extends BaseHookInput {
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions: string | null;
}

export interface PostCompactHookInput extends BaseHookInput {
  hook_event_name: 'PostCompact';
  trigger: 'manual' | 'auto';
  compact_summary: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
  session_title?: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  model?: string;
  session_title?: string;
}

export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: 'SessionEnd';
  reason: string;
}

/** Discriminated union of every kernel hook input. */
export type HookInput =
  | PreToolUseHookInput
  | PermissionRequestHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | PostToolBatchHookInput
  | NotificationHookInput
  | StopHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput;

// =============================================================================
// Outputs — the raw shape a single callback returns. Structurally compatible
// with the SDK's `HookJSONOutput` (`SyncHookJSONOutput | AsyncHookJSONOutput`)
// so an SDK callback's return value is assignable here. The DISPATCHER folds the
// chain of these into one `HookOutcome` (below).
// =============================================================================

/** The PreToolUse permission decision (SDK: `HookPermissionDecision`). */
export type HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer';

/** PreToolUse-specific output: the permission decision + input rewrite. */
export interface PreToolUseHookSpecificOutput {
  hookEventName: 'PreToolUse';
  permissionDecision?: HookPermissionDecision;
  permissionDecisionReason?: string;
  /**
   * K6-P3-C7: OPTIONAL structured classifier for a `deny` decision — the gate
   * ladder stage that produced it (e.g. 'security' | 'capability' | 'rule' |
   * 'mode' | 'floor'). Carried ALONGSIDE `permissionDecision`/`permissionDecisionReason`
   * for OBSERVABILITY only (it never affects the allow/deny/ask verdict). Typed
   * as a loose `string` here so the kernel contract stays provider-neutral and
   * does not import the host's GateResult union; the host narrows it. Additive —
   * absence is byte-identical to pre-C7 (the {}≠allow + chain semantics are
   * untouched: this rides with an existing `permissionDecision`, it does not
   * create one). X1: on an `ask`, the reserved 'floor' marks a card no standing allow
   * rule can silence (hard floor, ask rules), which no hook may answer either.
   */
  permissionDecisionReasonType?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

/** PostToolUse-specific output: tool-output rewrite + context. */
export interface PostToolUseHookSpecificOutput {
  hookEventName: 'PostToolUse';
  additionalContext?: string;
  /** Replaces the tool output before it is sent to the model. */
  updatedToolOutput?: unknown;
  /** MCP-only variant (SDK keeps both; prefer updatedToolOutput). */
  updatedMCPToolOutput?: unknown;
}

/**
 * X1 — PermissionRequest answers FOR the person (SDK shape). `updatedInput` rides
 * `allow` only and `message` / `interrupt` ride `deny` only; the dispatcher enforces
 * all three. `updatedPermissions` is accepted and never applied: a hook answers one card,
 * the person's standing rules are written only when the person answers one.
 */
export interface PermissionRequestHookSpecificOutput {
  hookEventName: 'PermissionRequest';
  decision?:
    | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
    | { behavior: 'deny'; message?: string; interrupt?: boolean };
}

/** A generic per-event specific output carrying only `additionalContext`. */
export interface GenericHookSpecificOutput {
  hookEventName: Exclude<HookEvent, 'PreToolUse' | 'PermissionRequest' | 'PostToolUse'>;
  additionalContext?: string;
}

/**
 * Synchronous hook output. Structurally a superset of the SDK's
 * `SyncHookJSONOutput` (extra/unknown keys are tolerated by structural typing).
 * `hookSpecificOutput` is intentionally widened to `unknown`-friendly union
 * members so SDK-shaped specific outputs assign through.
 */
export interface SyncHookJSONOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | PreToolUseHookSpecificOutput
    | PermissionRequestHookSpecificOutput
    | PostToolUseHookSpecificOutput
    | GenericHookSpecificOutput;
}

/** Async hook output (the callback defers; the dispatcher treats this as a
 *  fall-through — the kernel does not block on async hooks in B1). */
export interface AsyncHookJSONOutput {
  async: true;
  asyncTimeout?: number;
}

/** What a single callback returns. */
export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput;

// =============================================================================
// Callback + matcher — the registration shape. Byte-compatible with the SDK's
// `HookCallback` / `HookCallbackMatcher`.
// =============================================================================

/**
 * A single hook callback.
 *
 * Signature matches the SDK's `HookCallback`: `(input, toolUseId, { signal })`.
 * We accept BOTH async (`Promise<HookJSONOutput>`) and sync (`HookJSONOutput`)
 * returns — the SDK is Promise-only, but a sync return is a subtype of
 * `HookJSONOutput | Promise<HookJSONOutput>`, so SDK callbacks still assign.
 *
 * The `input` parameter is typed `HookInput` (the kernel union). Because
 * function parameters are contravariant, an SDK callback typed against the SDK's
 * `HookInput` union remains assignable as long as our inputs are structurally a
 * superset of theirs — which they are (we add `journalRef`, keep `transcript_path`
 * optional). The compat test proves this.
 */
export type HookCallback = (
  input: HookInput,
  toolUseId: string | undefined,
  opts: { signal: AbortSignal },
) => Promise<HookJSONOutput> | HookJSONOutput;

/** A registration group: an optional matcher + the callbacks + an optional
 *  per-group timeout (SECONDS, SDK-compatible). */
export interface HookCallbackMatcher {
  /** Regex tested against the dispatch key; absent = always matches. */
  matcher?: string;
  hooks: HookCallback[];
  /** Timeout in SECONDS for all hooks in this group (SDK convention). */
  timeout?: number;
}

// =============================================================================
// HookOutcome — the FOLDED result the dispatcher returns to the native loop
// (B2/B3). One value expressing the merged effect of an entire chain. Designed
// so the loop can act on it without re-reading per-callback shapes.
// =============================================================================

/**
 * What the dispatcher tells the loop to do after running a chain.
 *
 * - `continue`  — run the tool / proceed; carries merged `updatedInput`,
 *                 `updatedToolOutput`, `additionalContext`, and (for PreToolUse)
 *                 a `permissionDecision` if one was made.
 * - `halt`      — stop the agent (a callback returned `continue:false` or
 *                 `decision:'block'`); carries `stopReason`.
 *
 * A PreToolUse `permissionDecision` of `'deny'` / `'ask'` / `'defer'` is carried
 * on a `continue` decision (it is the tool-gate verdict, NOT an agent halt — the
 * loop decides how to apply deny/ask/defer to the single tool call). `'allow'`
 * is likewise carried. The ABSENCE of any decision after the whole chain means
 * "no hook spoke" — the loop falls back to its own default gate, NOT an implicit
 * allow. This is the security-critical distinction (see dispatcher §empty-return).
 */
export type HookOutcome =
  | {
      decision: 'continue';
      /** PreToolUse verdict if any callback set one; undefined = no hook decided. */
      permissionDecision?: HookPermissionDecision;
      /** Reason string accompanying the permission decision. */
      permissionDecisionReason?: string;
      /**
       * K6-P3-C7: OPTIONAL structured deny classifier (the gate ladder stage)
       * folded from the deciding callback's `permissionDecisionReasonType`.
       * Observability only — never affects the verdict. Carried alongside (and
       * gated by the presence of) `permissionDecision`.
       */
      permissionDecisionReasonType?: string;
      /** Merged PreToolUse input rewrite (later callbacks win per-key). */
      updatedInput?: Record<string, unknown>;
      /** Merged PostToolUse output rewrite (last writer wins). */
      updatedToolOutput?: unknown;
      /** Concatenated `additionalContext` from every surviving callback. */
      additionalContext?: string;
      /** X1 — a PermissionRequest `deny` that also said `interrupt: true` (stop the agent). */
      interrupt?: true;
    }
  | {
      decision: 'halt';
      /** Why the agent should stop (carried from `stopReason`/`reason`). */
      stopReason?: string;
      /**
       * X1 — set when the halt came from an event-specific `decision:'block'` and not
       * from `continue:false`. Claude Code gives the two different meanings on Stop
       * (block = keep going with the reason; continue:false = stop). A consumer that
       * does not read it treats both as a halt, exactly as before.
       */
      blocked?: true;
      /** Any context accumulated before the halt. */
      additionalContext?: string;
    };

/**
 * A type guard re-export point for the JournalEntry the journalRef ultimately
 * resolves to. Kept here so B2/B3 can import the contract's notion of "what a
 * hook can read" without re-deriving it. (No runtime cost — type-only.)
 */
export type HookReadableEntry = JournalEntry;

// =============================================================================
// K6-P2 B4 — HOOK OBSERVABILITY (the kernel side).
//
// The dispatcher accepts an INJECTED observer it calls around each callback
// invocation. KERNEL PURITY: the kernel emits these PROVIDER-NEUTRAL events to a
// callback the HOST supplies; it never imports a socket/sink and never stamps a
// wall clock (`durationMs` is the HOST observer's concern). With no observer the
// dispatcher makes ZERO observer calls → byte-identical.
// =============================================================================

/** The lifecycle phase of a single hook callback invocation. */
export type HookExecutionPhase = 'started' | 'completed' | 'error' | 'cancelled';

/**
 * One phase transition of a single callback invocation, handed to the injected
 * observer. `hookId` correlates a `started` with its terminal phase (completed /
 * error / cancelled). PROVIDER-NEUTRAL + clock-free: the kernel does NOT compute
 * `durationMs` (the host observer stamps it on the HarnessEvent it builds).
 */
export interface HookExecutionEvent {
  /** Stable per-invocation id (monotonic within a dispatcher). Correlates phases. */
  hookId: string;
  /** The HookEvent the callback is registered on. */
  hookEvent: HookEvent;
  /** The group's matcher regex, when the group declared one. */
  matcher?: string;
  /** The phase this event reports. */
  phase: HookExecutionPhase;
  /** Error message when `phase === 'error'`. */
  error?: string;
}

/**
 * Options for the dispatcher. INJECTED observability seam (the only field today).
 * Optional + default-undefined so `new HookDispatcher()` is unchanged.
 */
export interface HookDispatcherOptions {
  /**
   * Called around each callback invocation: `started` before, then exactly one of
   * `completed` / `error` / `cancelled`. Absent (or explicit `undefined`) → no
   * observability (byte-identical). MUST NOT throw — the dispatcher does not guard
   * it (the host keeps it trivial: map → host sink). Pure-kernel: the host owns the
   * clock + the sink. `| undefined` is explicit so a host can pass a flag-gated
   * `flag ? observer : undefined` under exactOptionalPropertyTypes.
   */
  onHookExecution?: ((ev: HookExecutionEvent) => void) | undefined;
  /**
   * X1 — match the way the Claude Code hooks reference does: `*` or empty matches all; a
   * matcher of letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name or a list of
   * them; anything else is an unanchored regex. Notification, SessionEnd and PostCompact
   * match on notification_type, reason and trigger; an event without matcher support
   * (UserPromptSubmit, Stop, PostToolBatch) ignores the matcher. Absent/false: every matcher
   * is a regex and those events match on '' (byte-identical). The host decides (the kernel
   * reads no flag).
   */
  claudeCodeMatchers?: boolean | undefined;
  /**
   * X1 — applied to each callback's `additionalContext` before the chain's are joined: the
   * host keeps an oversized one out of the context (the Claude Code reference saves text over
   * 10,000 characters to a file and passes a preview and the path). Absent: text as returned
   * (byte-identical). Synchronous, because the fold is; the kernel itself writes nothing.
   */
  spillContext?: ((text: string) => string) | undefined;
}

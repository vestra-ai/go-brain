import type { ContentBlock, TodoStatus } from './blocks.js';
import type { SubagentPathSegment } from './subagent-path.js';

/**
 * PR2 (Hermes transport-parity) — one block in the Anthropic verbatim-replay
 * channel. A faithful, order-preserving capture of the four content-block kinds
 * an Anthropic assistant turn can carry, used ONLY to reconstruct the wire shape
 * of a turn that interleaves SIGNED thinking with tool_use (think→tool→think→tool,
 * Claude 4.6+ interleaved-thinking beta) or carries a `redacted_thinking` block.
 *
 * Anthropic signs each thinking block against the content that PRECEDES it at its
 * position; the journal's normal split (an `assistant` entry of thinking+text, then
 * separate `tool_use` entries folded after) collapses that ordering and invalidates
 * the later signatures → 400 "Invalid signature in thinking block". This channel is
 * the Anthropic analogue of Hermes' `anthropic_content_blocks`: captured verbatim at
 * stream time, replayed verbatim on resume. Provider-scoped + additive — only the
 * Anthropic projection reads it; absent on every non-interleaved turn.
 */
export type AnthropicReplayBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /*
   * Any block type this SDK does not model — `server_tool_use`,
   * `tool_search_result`, `web_search_tool_result`, and whatever the provider
   * ships next — captured VERBATIM from its own final message.
   *
   * It exists because dropping such a block is not the harmless no-op it looks
   * like: a `thinking` block that comes AFTER it is signed over it, so losing it
   * makes that signature unverifiable and Anthropic rejects the entire request
   * (prod 09-16 — every retry, permanently). We do not need to understand a block
   * to replay it faithfully; we only need to not lose it.
   */
  | { type: 'provider_raw'; raw: unknown };

/**
 * Gemini Interactions verbatim-replay channel — one step of an assistant turn in
 * EXACT emission order (thought / text / function_call). Stateless Interactions
 * (`store:false`) requires every prior `thought` step resent with its
 * `signature` ("You MUST always resend all thought blocks exactly as they were
 * received"); the journal's normal split (an `assistant` entry of text, then
 * separate `tool_use` entries) has nowhere to keep a signed thought, so the turn's
 * ordered steps ride here. The Gemini twin of `AnthropicReplayBlock`: captured
 * verbatim at stream time, replayed verbatim by `journalToGeminiInteractionsSteps`
 * ONLY when the entry's `api` is `'gemini_interactions'` (the cross-issuer guard).
 * Provider-scoped + additive — absent on every other dialect's turn.
 */
export type GeminiReplayStep =
  | { type: 'thought'; signature: string; summary?: string }
  | { type: 'text'; text: string }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> }
  /*
   * A step exactly as the provider streamed it, in the Interactions wire shape
   * (`thought` with a `summary` ARRAY, `model_output` with its `content` items,
   * `function_call`, and any step type this SDK does not model). Every channel
   * written since the seal (09-23) holds only these; the three shapes above are
   * what older journals carry, and the projection still reads them. We do not
   * need to understand a step to send it back; we only need to not lose it.
   */
  | GeminiWireStep;

/** One Interactions step verbatim — see GeminiReplayStep. */
export type GeminiWireStep = { type: string; [k: string]: unknown };

/**
 * Gemini generateContent verbatim-replay channel: the candidate's model `Content`
 * parts exactly as streamed (every part, every chunk, in order — text, thought,
 * functionCall with its provider `id`, the `thoughtSignature` on whichever part
 * carries it, the trailing empty text part, and any part kind this SDK does not
 * model). Gemini 3 signs only the FIRST of a parallel call run and 400s a request
 * whose functionCall turn lost it ("Function call is missing a thought_signature",
 * probed 2026-09-23), so the turn is sent back as this, never rebuilt.
 *
 * `callIds[i]` is the internal tool_use id the i-th functionCall part was
 * journaled under — the link from the sealed turn to its tool_use / tool_result
 * entries (pruning, result pairing).
 */
export interface GeminiContentReplay {
  parts: Array<Record<string, unknown>>;
  callIds: string[];
}

/**
 * OpenAI Responses verbatim-replay channel: the `output` array of the provider's OWN
 * final response (`response.completed` / `.incomplete`), every item in order —
 * reasoning (summary + `encrypted_content`), each message item with its id and
 * `phase`, function_call with the RAW `arguments` string, and any item type this SDK
 * does not model. The final response's reasoning blob differs from the one the
 * `output_item.done` event carried (probed 2026-09-23), so nothing is rebuilt from
 * the stream. A function_call's `call_id` IS our tool_use id, so no id map is needed.
 *
 * `issuer`: the provider that minted it — an `encrypted_content` decrypts only there.
 */
export interface ResponsesOutputReplay {
  items: Array<Record<string, unknown>>;
  issuer?: string;
}

/**
 * Chat Completions verbatim-replay channel: the assistant message as the provider
 * streamed it. Streaming has no final message, so it is the deltas' own fields
 * joined in arrival order (content, reasoning_content, any other string field) and
 * tool_calls by index with their ids and RAW argument strings.
 */
export type ChatMessageReplay = { role: 'assistant'; [k: string]: unknown };

export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'system' };

/**
 * P5.1 (Agent Teams) — the durable DEFINITION of a teammate the lead spawned via
 * the Agent tool (mode:'teammate'). Journaled once at spawn so a cold resume can
 * reconstruct the roster (name → systemPrompt/toolset/model) without replaying the
 * spawn turn. CONTEXT_POLICY:false — a roster definition is state, not a message the
 * model re-reads. Additive; dark behind the AGENT_TEAMS flag until P5.2 wires writers.
 */
export interface TeammateDefEntry {
  type: 'teammate_def';
  name: string;
  parentTaskId: string;
  systemPrompt: string;
  toolset: string[];
  model?: string;
  // I-7 (P5.2 review) — the teammate's ORIGINAL brief (the spawn's spec.prompt).
  // Journaled here so a child that crashed between spawn-settle and its first
  // dispatch (no user turn ever ran) can have its brief RE-DELIVERED ahead of a
  // later SendMessage, instead of coming up cold with no task. Additive-optional.
  firstPrompt?: string;
  /**
   * Phase 2 (spec 2026-09-02-orchestration-design §4.7, D9) — 'helper' = a
   * background one-shot helper: the same task-scoped actor, minus the roster slot
   * and the name, and it ALWAYS reports back. Absent = a named teammate (every
   * pre-Phase-2 def), so a cold resume of a live teammate reads exactly as before.
   */
  kind?: 'teammate' | 'helper';
  /** The Agent call's `description` — the helper's display name and report handle. */
  description?: string;
  /**
   * Orchestration walls — the depth this actor's OWN Agent tool is built at
   * (helper = 1). A background helper is spawned by a depth-0 Agent call and runs
   * as its own actor, so its own tool is built at 1 and the walls keep counting
   * from the lead's tree rather than restarting at 0.
   */
  depth?: number;
  /** The LEAD task that roots tree admission and spawn stats for this actor. */
  rootTaskId?: string;
  /**
   * Follow-up B — the SUBAGENT TYPE the helper was spawned as (the roster slug: researcher,
   * explorer, general-purpose, or an installed ability's agent). It rode only the
   * `subagent:spawned` wire payload, which the helper's own actor never reads: the actor
   * rebuilds itself from THIS def, so without the type here it could not resolve its own
   * per-type turn cap and ran on the sandbox-wide budget (staging task c7612bfd, sixty
   * rounds of search). Additive-optional: a def written before this resolves to the same
   * default it already had. A named teammate has no type, so this is helper-only.
   */
  subagentType?: string;
}

/** Who minted an engine-written `user` entry (`payload.injected`): the door it came through. */
export type InjectedDoor = 'engine' | 'hook' | 'engine_handover' | 'context_update';

export type JournalPayload =
  | {
      type: 'user';
      blocks: ContentBlock[];
      /**
       * Nami P1.1 — provenance marker for an INVISIBLE control turn (the hot
       * end-of-task memory pass). The turn is journaled for billing/audit but
       * must never re-enter the MODEL's context: both wire projections strip
       * marked turns via `stripInvisibleControlTurns`. Absent on every real
       * user message → byte-identical journal on the normal path.
       */
      control?: 'memory';
      /**
       * W4-2 — this entry was minted by the LOOP, not typed by a person.
       * `appendUserEntry` has nine call sites and six of them write into the user
       * channel because the wire has no other role for "here is a fact the next
       * model call must see"; the value says which kind:
       *
       *   'engine' — a text the loop itself authored (the severance continuation,
       *              a recall fence, the runaway directive, a schema retry).
       *   'hook'   — a hook's `additionalContext`, verbatim. Carries no signature
       *              of any kind, and the PostToolBatch hook that produces it is
       *              handed the raw tool_result bytes — so this is one of the two
       *              values that can mean "third-party content reached a user entry".
       *   'engine_handover' — Engines T5 (spec §6.9): the conversation a task had on a
       *              subscription engine, brought over at its first native run open
       *              (contract/injected-user-text.ts ENGINE_HANDOVER_DOOR). The HOST
       *              fetched it (the server's record); it quotes tool output fenced as
       *              data, so it is the other value that can carry third-party content.
       *   'context_update' — CONTEXT_APPEND_V1 (engine/context-append.ts): a later run of the
       *              session telling the model what part of its standing context now reads
       *              differently (memory, the tool index, SessionStart context), or that its
       *              instructions were refreshed. Its own value so a reader that harvests
       *              what the person said (the memory sweep) can skip it by this field.
       *
       * Absent on every entry a PERSON authored (the turn's ask, a mid-turn steer,
       * a polled staged message) → byte-identical journal on the normal path, and
       * absent on every entry written before this field existed, which is why the
       * text-based recogniser in policy/injection-screen.ts stays as the fallback
       * for a warm task resuming across a deploy.
       */
      injected?: InjectedDoor;
    }
  | {
      type: 'assistant';
      blocks: ContentBlock[];
      api?: string;
      provider?: string;
      model?: string;
      /**
       * PR4 P2 (OpenAI/Sakana-SCOPED) — HEAD/orphan encrypted reasoning items
       * captured off the stream that preceded NO function_call (so they cannot ride
       * a tool_use entry). Persisted here so `journalToOpenAIResponsesInput` echoes
       * them as `{type:'reasoning'}` items BEFORE this assistant message on reload —
       * a leading/orphan reasoning otherwise drops on reload (stateless reasoning
       * models 400 on a missing item). Optional + provider-tagged: ONLY the OpenAI
       * Responses projection reads it; `journalToAnthropicMessages` reads named
       * fields and never touches it, so the Anthropic arm stays BYTE-IDENTICAL.
       * Absent on every Anthropic + non-reasoning OpenAI assistant entry.
       */
      reasoning?: Array<{ id: string; encryptedContent: string; issuer?: string }>;
      /**
       * PR2 (ANTHROPIC-SCOPED) — the assistant turn's content blocks in EXACT
       * emission order (thinking / redacted_thinking / text / tool_use), captured
       * verbatim ONLY when the turn interleaves signed thinking with tool_use, or
       * carries a `redacted_thinking` block on a tool turn. When present,
       * `journalToAnthropicMessages` replays THIS order as the assistant message
       * and SKIPS folding the `tool_use` entries it already contains — preserving
       * each thinking block's signature context across the tool calls. Absent on
       * every other turn → the default split projection runs → BYTE-IDENTICAL; only
       * the Anthropic projection reads it, so non-Anthropic arms are untouched.
       */
      anthropicBlocks?: AnthropicReplayBlock[];
      /**
       * GEMINI-INTERACTIONS-SCOPED — the assistant turn's ordered steps, captured
       * verbatim on every round (before 09-23: only when a signed `thought` was
       * seen, in the normalized shapes GeminiReplayStep still reads). When
       * present AND `api === 'gemini_interactions'`, `journalToGeminiInteractionsSteps`
       * replays THIS order and SKIPS folding the `tool_use` entries it already
       * contains. Absent on every other turn and every other dialect → the default
       * split projection runs → BYTE-IDENTICAL; only the Gemini Interactions
       * projection reads it.
       */
      geminiSteps?: GeminiReplayStep[];
      /**
       * GEMINI-GENERATECONTENT-SCOPED — the assistant turn's model Content, captured
       * verbatim on every round (see GeminiContentReplay). When present AND
       * `api === 'gemini'`, `journalToGeminiContents` sends THIS as the model turn
       * and SKIPS folding the `tool_use` entries it already contains.
       */
      geminiContent?: GeminiContentReplay;
      /**
       * OPENAI-RESPONSES-SCOPED — the round's `response.output`, captured verbatim on
       * every round (see ResponsesOutputReplay). When present AND
       * `api === 'openai_responses'`, `journalToOpenAIResponsesInput` sends THESE items
       * and SKIPS folding the `tool_use` entries they already contain. Supersedes the
       * per-record `reasoning` fields for every round written since 09-23.
       */
      responsesOutput?: ResponsesOutputReplay;
      /**
       * CHAT-COMPLETIONS-SCOPED — the round's assistant message as streamed (see
       * ChatMessageReplay). When present AND `api === 'openai_chat_completions'`,
       * `journalToChatCompletionsMessages` sends THIS message and SKIPS folding the
       * `tool_use` entries it already contains.
       */
      chatMessage?: ChatMessageReplay;
    }
  | {
      type: 'tool_use';
      toolUseId: string;
      name: string;
      input: unknown;
      /**
       * §4.3a (OpenAI/Sakana-SCOPED) — encrypted reasoning items captured off the
       * stream that PRECEDED this tool call, echoed back before its function_call by
       * `journalToOpenAIResponsesInput` so stateless reasoning models (store:false)
       * don't 400. Optional and provider-tagged: ONLY the OpenAI Responses projection
       * reads it; `journalToAnthropicMessages` reads named fields and never touches it,
       * so the Anthropic arm's journal + wire path stay BYTE-IDENTICAL. Absent on
       * every Anthropic and non-reasoning OpenAI tool_use (byte-identical there too).
       */
      reasoning?: Array<{ id: string; encryptedContent: string; issuer?: string }>;
      /**
       * PR6 (GEMINI-SCOPED) — the Gemini-3 `thoughtSignature` attached to this tool
       * call. Gemini-3 thinking models 400 if a functionCall is replayed WITHOUT its
       * signature, so `journalToGeminiContents` re-emits it on the functionCall part.
       * Optional + provider-tagged: ONLY the Gemini projection reads it; the Anthropic /
       * OpenAI projections read named fields and never touch it → byte-identical. Absent
       * on every non-Gemini-3 tool_use.
       */
      thoughtSignature?: string;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      blocks: ContentBlock[];
      isError?: boolean;
      /**
       * S2a (COMPUTER-USE-SCOPED) — the browser actuator's action report, persisted
       * verbatim alongside the result blocks so risk/effect ground truth survives a
       * recycle. Intended shape: `BrowserActionReport`
       * (packages/shared/src/computer-use/action-report.ts) — typed `unknown` because
       * @vestra/agent-sdk does NOT depend on @bash/shared; validated structurally at
       * the dispatcher and fully (`isBrowserActionReport`) at the sandbox boundary.
       * Optional + tool-scoped like `reasoning`/`thoughtSignature` above: NO wire
       * projection reads it (the model context replays `blocks` only), so every
       * non-browser tool_result — and every projection — stays BYTE-IDENTICAL.
       */
      report?: unknown;
      /**
       * W4-1 (taint at the mint) — 'external' when this result came from a tool
       * that declared `untrustedContent` (web fetch/search, browser reads,
       * connector reads): third-party bytes, never instructions. The FENCE rides
       * in `blocks` themselves (the dispatcher wraps the result text at the mint,
       * the truncation-marker precedent), so projections replay it byte-stably
       * WITHOUT reading this field; the field is the queryable signal for
       * downstream policy (the W4-2 pre-side-effect screen) and for audit.
       * Additive-optional, spread-when-present at every append site — absent on
       * every untainted entry ⇒ byte-identical journal lines.
       */
      taint?: 'external';
    }
  | { type: 'system'; event: string; data?: unknown }
  | { type: 'usage'; intelligence: number; actions: number; compute: number; raw?: unknown }
  | { type: 'compact_boundary'; summaryUuid: string; preservedUuids: string[]; firstKeptId: string; trigger: 'auto' | 'manual'; preTokens: number; postTokens: number }
  | { type: 'interaction'; interactionId: string; resolved: boolean; data?: unknown }
  | { type: 'mode'; key: string; value: unknown }
  | { type: 'custom'; key: string; data: unknown }
  | { type: 'custom_message'; blocks: ContentBlock[]; display?: boolean }
  | { type: 'label'; name: string }
  | {
      /**
       * Phase 3 (§1.4) — a `write_todos`/`Plan` mutation, folded by `projectPlan()`
       * into the current todo list. Replaces the volatile in-memory `stores` Map
       * (apps/sandbox tools/task-tools.ts) that never rehydrated on a fresh-process
       * resume (`native-todo-store-volatile-on-resume`): the list is now derived
       * straight from the durable journal, so a cold `Journal.hydrate()` → `project()`
       * reconstructs it identically — no separate seeding step exists to forget.
       * CONTEXT_POLICY:false — a todo mutation is state, not a message the model
       * replays; the model sees the list via the tool's own return value.
       * Scoped like any other entry via `agentPath` (T10/T11a projectScope), which is
       * how a subagent's plan stays agent-private (AC-P2): its `plan` entries carry
       * its own `agentPath` and are excluded from the main projection, and vice versa.
       */
      type: 'plan';
      op: 'create' | 'update' | 'delete';
      id: string;
      content?: string;
      status?: TodoStatus;
      activeForm?: string;
      /**
       * §4.7 (the board) — the roster handle holding this item. Absent on a
       * `create`/`update` that says nothing about ownership (today's shape,
       * byte-identical); `null` on an `update` is an explicit UNASSIGN, which
       * `projectPlan()` folds by deleting the key (a projected item never
       * carries `owner: null`).
       */
      owner?: string | null;
    }
  | {
      /**
       * P2.3 (§Phase 2) — a SETTLED unit of durable work (a Weave node, a subagent
       * run), journaled AT THE MOMENT it settles and keyed by a stable hash of its
       * spec. On re-execution the dispatcher consults the memo (kernel/journal/
       * step-memo.ts `findStepMemo`) BEFORE admitting the unit and returns this
       * outcome at $0 — a killed mid-orchestration run resumes re-running ZERO
       * settled units. It REFERENCES the journal (via `scope` + the surrounding
       * entries), never embeds the run's full history (the anti-Eve-quadratic rule):
       * `resultText` is the outcome text only, bounded to ≤64KB at the append
       * boundary. CONTEXT_POLICY:false — a checkpoint is accounting/replay state, not
       * a message the model re-reads (isContextEntry → false), so projections + wire
       * bodies stay byte-identical; it exists purely for the resume-time memo consult.
       * No writers land in this slice — Task 8 wires the Weave/subagent consult.
       */
      type: 'step_result';
      scope: string;           // `weave:${scriptHash}` | subagentId (the memo bucket)
      specHash: string;        // stable hash of the unit's spec (hashNodeSpec)
      status: 'ok' | 'error';
      resultText: string;      // the NodeOutcome / subagent final text (bounded, ≤64KB)
      costUsd: number;         // what the settled run cost (informational; memo hits bill $0)
      settledAt: string;       // ISO — passed in, never read from the clock
    }
  | {
      /**
       * P2.4 (§Phase 2) — an append-only REWIND marker. `Journal.rewindTo(pivotUuid)`
       * appends one, then forks the leaf so new turns continue from the pivot. In the
       * projection pipeline `applyRewind` (kernel/journal/journal.ts) drops the ABANDONED
       * span — every CONTEXT entry appended after the pivot but before this marker — from
       * the model's messages, exactly like compaction: last marker wins, disk is never
       * rewritten, and NON-context state (todos / usage / interactions) survives. Because
       * `parentUuid` is threaded globally-linear (concurrent siblings interleave into one
       * chain), a leaf-walk cannot recover the abandoned span; this seq-anchored marker
       * can. CONTEXT_POLICY:false — a rewind marker is projection state, not a message the
       * model re-reads, so wire bodies stay byte-identical and it never appears in context.
       */
      type: 'rewind_boundary';
      pivotUuid: string;       // the entry the projection rewinds TO (kept; its span-successors dropped)
    }
  | TeammateDefEntry;

/**
 * One entry in a task's append-only journal — the kernel's source of truth.
 * INVARIANTS (enforced by lint + tests):
 *  - secret-free: no field holds a credential value (handles only, elsewhere).
 *  - workspace-scoped: workspaceId is required (the tenant boundary).
 *  - append-only: no mutation/delete shape exists.
 */
export interface JournalEntry {
  uuid: string;
  parentUuid: string | null;
  seq: number;
  taskId: string;
  rootTaskId: string;
  spawnDepth: number;
  workspaceId: string;
  agentId: string;
  principal: Principal;
  timestamp: string; // ISO 8601 — always passed in; pure code never reads the clock
  /**
   * T10 (durable subagent deep-HITL, Phase B) — the root→leaf `SubagentPathSegment[]`
   * that SCOPES this entry to the subagent whose inner conversation it belongs to.
   * Present ONLY on entries a nested subagent loop journals for its OWN rounds; the
   * deepest segment's `agentToolUseId` is the leaf `SubagentId`. A later task projects
   * by this scope (`projectScope`) to re-enter a paused subagent from journaled state
   * instead of replaying its model rounds.
   *
   * ABSENT on every main-agent entry. Written with a CONDITIONAL spread —
   * `agentPath: undefined` is NEVER serialized — so a main-agent line is byte-for-byte
   * identical to before this field existed (asserted by the golden test in
   * native-journal.agent-path.test.ts).
   */
  agentPath?: SubagentPathSegment[];
  /**
   * P2.0 — journal schema version; absent = v1 legacy. Hydration accepts
   * v ≤ CURRENT_JOURNAL_VERSION (kernel/journal/validate-entry.ts) and rejects a
   * FUTURE version — a downgraded process must not misread a newer schema.
   * Nothing stamps v on append yet (a future P2 slice enables stamping), so
   * every written line stays byte-identical to pre-P2.0.
   */
  v?: number;
  payload: JournalPayload;
}

/** What a caller provides to append(); the store assigns uuid/parentUuid/seq. */
export type NewEntry = Omit<JournalEntry, 'uuid' | 'parentUuid' | 'seq'>;

/** Whether each payload type is replayed into the model's context on resume.
 *  Exhaustive by construction: adding a JournalPayload variant without classifying
 *  it here is a COMPILE ERROR (Record requires every key). */
const CONTEXT_POLICY: Record<JournalPayload['type'], boolean> = {
  user: true,
  assistant: true,
  tool_use: true,
  tool_result: true,
  system: true,
  custom_message: true,
  usage: false,
  compact_boundary: false,
  mode: false,
  custom: false,
  label: false,
  interaction: false,
  plan: false,
  step_result: false,
  rewind_boundary: false,
  teammate_def: false,
};

/** True when this entry's payload is part of what the model sees on replay. */
export function isContextEntry(e: JournalEntry): boolean {
  return CONTEXT_POLICY[e.payload.type];
}

/**
 * Nami P1.1 — strip INVISIBLE control turns from a model-bound entry list.
 *
 * The hot end-of-task memory pass is journaled as a real turn (billing/audit
 * must see it) but must never re-enter the model's context: replaying the sweep
 * makes the model treat it as the latest exchange (it answers the user's next
 * message with "I saved the useful context…", and the next-prompt side-call
 * predicts sweep follow-ups). Drops every user entry marked `control:'memory'`
 * plus everything chained under it via parentUuid — with the chain STOPPING at
 * any unmarked user entry, so a real turn that happens to parent onto a dropped
 * entry always survives. Entries arrive seq-ordered (children after parents),
 * so one forward pass suffices. Callers: the wire projections
 * (journalToAnthropicMessages / journalToOpenAIResponsesInput) and the
 * next-prompt suggestion window — NOT project() itself.
 */
export function stripInvisibleControlTurns(entries: JournalEntry[]): JournalEntry[] {
  const dropped = new Set<string>();
  const out: JournalEntry[] = [];
  // The journal path re-projects on EVERY model call, including the pass's own:
  // there the marked user prompt is the FINAL entry (its reply does not exist
  // yet) and must survive, or the sweep request goes out with no user turn and
  // the pass silently dies. A completed pass (reply landed → the marked entry is
  // no longer last) strips as usual.
  const last = entries[entries.length - 1];
  for (const e of entries) {
    const isMarkedUser = e.payload.type === 'user' && e.payload.control === 'memory';
    const chainsToDropped =
      e.payload.type !== 'user' && e.parentUuid !== null && dropped.has(e.parentUuid);
    if ((isMarkedUser && e !== last) || chainsToDropped) {
      dropped.add(e.uuid);
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * P2.0 — the closed set of payload kinds, derived from CONTEXT_POLICY's keys so it
 * can never drift from the union (a variant missing from CONTEXT_POLICY is already
 * a compile error; this re-exposes that same closed set for runtime validation in
 * kernel/journal/validate-entry.ts).
 */
export const JOURNAL_PAYLOAD_TYPES = Object.keys(CONTEXT_POLICY) as readonly JournalPayload['type'][];

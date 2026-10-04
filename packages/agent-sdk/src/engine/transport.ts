import type { MemorySpan } from '../contract/instruction-stack.js';
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import type {
  AnthropicReplayBlock,
  ChatMessageReplay,
  GeminiContentReplay,
  GeminiReplayStep,
  JournalEntry,
  ResponsesOutputReplay,
} from '../contract/journal.js';
import type { ModelUsageSummary, TurnOutcome } from '../contract/turn-outcome.js';
import type { OutputFormat } from '../contract/output-format.js';
import type { CachePrefixHint } from '../contract/cache-prefix-hint.js';
import type { RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';

/** Provider-neutral usage the loop bills on. */
export interface NormalizedUsage {
  /**
   * Prompt/input tokens, EXCLUSIVE of the cache buckets on EVERY arm (the
   * Anthropic shape: cacheRead/cacheCreation are disjoint additive buckets;
   * total prompt = input + cacheRead + cacheCreation). Providers that report
   * an inclusive input (OpenAI Responses / Chat Completions) are normalized
   * at their producer (normalizeResponsesUsage / normalizeChatUsage) — wire
   * consumers never see a per-provider convention. Single convention since
   * 2026-08-04 (billing_partial_underbill incident: the server's billable-
   * token floor priced 2.4M cached tokens at the full-rate floor).
   */
  inputTokens: number;
  outputTokens: number;
  /** Cached prompt tokens read from cache — always a disjoint additive bucket. */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * Anthropic's split of `cacheCreationInputTokens` by cache TTL (the wire's
   * `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`;
   * 5m + 1h = the aggregate). Anthropic bills a 5-minute write at 1.25x input and a
   * 1-hour write at 2x, and the model proxy rewrites every breakpoint to a 1h TTL —
   * so a pricer that sees only the aggregate bills every write at 1.25x (prod
   * 09-15..09-28: $33.68 of a $34.51 residual against Anthropic's own cost report).
   * Set by the Anthropic transport whenever the wire carried the object; absent on
   * every other arm (byte-identical).
   */
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  /**
   * Fugu/Sakana orchestration tokens (multi-agent coordination), summed across
   * the orchestration_* usage fields. Read by computeFuguCostUsd and billed at
   * the active tier rate. Absent for every non-Fugu provider (byte-identical).
   */
  orchestrationTokens?: number;
}

/** What `readStream` yields — fully provider-neutral. */
export type StreamEvent =
  | { kind: 'text'; text: string }
  /**
   * A thinking/reasoning block has OPENED — emitted the moment the provider starts
   * a thinking block (Anthropic `content_block_start` type=thinking; OpenAI the
   * reasoning output item), BEFORE any `thinking` fragment. Lets the UI mount the
   * thinking pill + its running timer immediately: Anthropic's summarized adaptive
   * thinking lags the block start by seconds, so waiting for the first fragment
   * leaves the user staring at nothing. Providers/models without thinking never
   * yield this → byte-identical.
   */
  | { kind: 'thinking_start' }
  // A LIVE thinking/reasoning fragment (streamed token-by-token → AGENT_THINKING_DELTA).
  | { kind: 'thinking'; text: string }
  /**
   * A COMPLETED thinking block carrying its provider signature (Anthropic
   * extended thinking). Emitted by readStream AFTER the turn's live fragments,
   * BEFORE the `done`. The kernel loop journals these (in order, before the
   * assistant text/tool_use) so the NEXT request can replay thinking+signature —
   * the multi-turn correctness contract for interleaved thinking. Providers
   * without a replayable signature simply never yield this (their thinking is
   * live-only via `thinking`).
   */
  | { kind: 'thinking_block'; thinking: string; signature?: string }
  // PR6 — `thoughtSignature` (Gemini-3 only) rides the tool_use so the loop can journal
  // it on the tool_use entry and re-emit it on replay. Absent on Anthropic/OpenAI/Chat.
  | { kind: 'tool_use'; toolUse: { id: string; name: string; input: unknown; thoughtSignature?: string } }
  /**
   * L1 (TOOLS_MIDSTREAM_V1) — one tool call is CLOSED, emitted live the moment the provider
   * closes it (Chat Completions: when the next call opens with this one's arguments and id in
   * hand, or the choice finishes; Gemini: the chunk that carries it), for EVERY call and in
   * call order. `input` is the parsed arguments, or undefined when they do not parse: such a
   * call never starts early, but it is still seen, so an unreadable exclusive call shuts the
   * door behind it. A heads-up only: the same call still arrives as `tool_use` after the
   * stream, and that one is what the loop journals and runs. Emitted only while the flag is
   * on, so every other consumer of a stream sees today's events.
   */
  | { kind: 'tool_ready'; toolUse: { id: string; name: string; input: unknown } }
  | {
      kind: 'done';
      stopReason: string | null;
      usage: NormalizedUsage;
      /**
       * This round's content exactly as the provider sent it (see ProviderReplay).
       * Carried ON the event (not stashed on the transport) so every reader — the
       * main loop and any number of concurrent subagents sharing one transport —
       * gets its own round's copy.
       */
      replay?: ProviderReplay;
    };

/**
 * A round's sealed provider output, one shape per dialect: Anthropic's content
 * blocks (a bare array, the original shape), Gemini generateContent's model
 * Content, Gemini Interactions' steps, OpenAI Responses' `output` items, Chat
 * Completions' assistant message. Only the transport that minted it reads
 * it back (pushAssistant); the loop just carries it and journals it on the
 * matching assistant-entry channel (see replayChannels in native-journal.ts).
 */
export type ProviderReplay =
  | AnthropicReplayBlock[]
  | { dialect: 'gemini'; content: GeminiContentReplay }
  | { dialect: 'gemini_interactions'; steps: GeminiReplayStep[] }
  | { dialect: 'openai_responses'; output: ResponsesOutputReplay }
  | { dialect: 'openai_chat_completions'; message: ChatMessageReplay };

/** Opaque provider history + stream handles — the loop never inspects these. */
export type ProviderHistory = unknown;
export type ProviderStream = unknown;
export type ProviderTool = unknown;

/**
 * A ModelPort. The kernel loop drives this and NEVER imports a provider SDK.
 * One implementation per wire dialect (anthropic_messages, openai_responses, …).
 */
export interface Transport {
  readonly api: string;      // 'anthropic_messages' | 'openai_responses' — stamped into the journal
  readonly provider: string; // 'anthropic' | 'openai'

  emptyHistory(): ProviderHistory;
  /** Project journal context entries → this provider's input shape (cross-model: strip foreign reasoning). */
  historyFromJournal(entries: JournalEntry[]): ProviderHistory;
  /** Append the assistant turn (text + tool_use blocks) to the in-flight history. */
  /**
   * `replay`: the round's verbatim provider content from the `done` event. When
   * present (and this transport's own dialect) it IS the assistant message —
   * `blocks` is only the fallback.
   */
  pushAssistant(h: ProviderHistory, blocks: ContentBlock[], replay?: ProviderReplay): void;
  /** Append a tool result to the in-flight history. */
  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void;
  /**
   * A single user message (for the no-journal in-memory path). `images` (uploaded
   * with the turn) ride alongside the text when the provider can represent them,
   * and `media` (VIDEO_UNDERSTANDING_V1 — video / audio / PDF) likewise. Only the
   * Gemini transport reads `media`; every other implementation ignores it, which
   * is what keeps their wire byte-identical.
   */
  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], media?: MediaBlock[]): void;

  buildTools(raw: RawToolOptions[]): ProviderTool[];
  /**
   * OPTIONAL (WARM_CONNECTIONS_V1): open a connection to the host `model`'s requests
   * go to, with no request, so the turn's first call skips the handshake. Called
   * once per turn by the turn head. Best effort: never throws; absent = nothing.
   */
  prewarm?(model: string): void;
  /**
   * OPTIONAL (LANE_FALLBACK_V1): move this transport's requests for `model` to the second route
   * to the same provider (transports/lane-fallback.ts apiPlaneRoute): the same credential-proxy
   * path on the API plane, until `until` (default: LANE_FALLBACK_HOLD_MS from now), then back to
   * the lane. True when it switched; false when there is no second route (the API plane does not
   * serve that provider, or the lane is not one of our proxy routes) or the move already holds.
   * Absent = no second route.
   */
  fallBackLane?(model: string, until?: number): boolean;
  /**
   * OPTIONAL (CONTEXT_APPEND_V1, C7): the reasoning effort a LOOP request for `model` carries on
   * this wire, resolved by the same function the request build uses (registry, env override,
   * clamp), or undefined when the request carries none. Read once per run to tell the model a
   * setting changed; never on the wire itself. Absent = no effort to report.
   */
  reasoningEffort?(model: string): string | undefined;
  callModel(p: {
    model: string;
    system: string;
    tools: ProviderTool[];
    history: ProviderHistory;
    signal?: AbortSignal;
    maxTokens: number;
    /**
     * OPTIONAL run-level structured-output request (K6-P6). When present, the
     * provider transport constrains THIS call's final answer to the schema
     * (E2/E3). Absent ⇒ fully unconstrained (byte-identical). The kernel only
     * sets this on the dedicated terminal constrained call (§3.1), never on the
     * tool-using loop calls.
     */
    outputFormat?: OutputFormat;
    /**
     * OPTIONAL adaptive-cache hint (K4C-3 D2). The kernel sets this on the main
     * per-round model calls (the ones sending the full projected history) IFF the
     * projection leads with a compaction summary, so a token-aware transport can
     * anchor the stable post-compaction prefix. Absent ⇒ byte-identical placement.
     * NEVER set on the summarize one-shot (it summarizes an ephemeral span).
     */
    cachePrefixHint?: CachePrefixHint;
    /**
     * OPTIONAL fleet-prefix tier boundary (CACHE_TIERING_V1). Byte offset into
     * `system` where the fleet-static prefix (identical bytes for every user and
     * task of a deploy — see FLEET_STATIC_LAYER_IDS) ends. A breakpoint-placing
     * transport (Anthropic) may split the system into [fleet | session] blocks at
     * this offset so the fleet prefix caches org-wide while the per-user/session
     * remainder varies behind it. The CONCATENATED bytes are unchanged by
     * construction. Absent or out-of-range ⇒ single system block, byte-identical
     * request. Transports without explicit breakpoints ignore it.
     */
    systemFleetPrefixChars?: number;
    /**
     * OPTIONAL memory span (CHAT_TAIL_AFTER_TOOLS_V1 / RESPONSES_MEMORY_INPUT_V1): where the
     * memory blocks sit in `system` (instruction-stack.ts memorySpan, measured once per run). The
     * bytes around it are what a person's tasks share. A transport whose provider caches only up
     * to where two tasks first differ may send the memory elsewhere: Chat Completions as a second
     * system message on a build that renders tools after the first (fireworks-wire.ts), OpenAI
     * Responses as the first user input item on a boundary-cache build (openai-cache-boundaries.ts).
     * Absent or malformed ⇒ `system` whole, byte-identical. Every other transport ignores it.
     */
    systemMemorySpan?: MemorySpan;
    /**
     * OPTIONAL stable cache-routing anchor for providers with an explicit
     * prompt-cache key (OpenAI Responses `prompt_cache_key`). The kernel sets this
     * to a per-task-stable value (the run's sessionId, falling back to taskId) on
     * the MAIN per-turn model call(s) so every turn of one task routes to the same
     * cache shard — turning OpenAI's automatic prefix cache from luck into a
     * deliberate hit. Providers that don't expose a cache key (Anthropic, whose
     * cache routing is `cache_control`-driven) simply IGNORE this → their request
     * body is byte-identical whether it is set or not. Absent ⇒ no `prompt_cache_key`
     * sent (the contract-level byte-identity guard).
     */
    cacheKey?: string;
    /**
     * OPTIONAL "do not write this request into the prompt cache" (COMPACTION_V2).
     * Set ONLY on genuinely one-shot calls whose prefix can never be read again —
     * today just the compaction summarize, which renders a span the compaction is
     * about to delete.
     *
     * Why it matters beyond the write premium: a cache write on a ~200k one-shot
     * prefix competes with the LIVE task prefix for cache residency, so paying to
     * store bytes nobody will read can also evict the bytes everybody reads and
     * force a cold re-write on the very next round.
     *
     * A breakpoint-placing transport (Anthropic) should place NO `cache_control`
     * when this is set. Transports whose caching is automatic (OpenAI prefix
     * caching) have nothing to switch off and ignore it. Absent ⇒ byte-identical
     * placement, which is what keeps the flag-off path unchanged.
     */
    noCacheWrite?: boolean;
    /**
     * OPTIONAL reasoning FLOOR for a one-shot side call (the Nami memory sweep). 'low' is the
     * least effort every dialect here accepts without a probe: OpenAI Responses and Chat
     * Completions `reasoning_effort`, the Anthropic `output_config.effort`, the Gemini
     * `thinking_level`. Applied ONLY where the model already sends an effort: a row with no
     * effort param gets nothing new on the wire. Absent ⇒ byte-identical request.
     */
    reasoningEffort?: 'low';
    /**
     * OPTIONAL effort for the LAST user turn only, sent as a per-message change instead of a
     * top-level one (SWEEP_EFFORT_MESSAGE_V1: the memory sweep riding the loop's exact request).
     * A transport places it only where the model takes that change without a cache reset
     * (registry `thinking.perMessageEffort`, see contract/per-message-effort.ts) and leaves every
     * other request exactly as it is. Absent ⇒ byte-identical request.
     */
    turnEffort?: 'low';
  }): ProviderStream;
  /** Translate the provider stream into normalized events, ending with exactly one `done`. */
  readStream(stream: ProviderStream): AsyncIterable<StreamEvent>;

  /**
   * OPTIONAL (§4.3a, OpenAI/Sakana reasoning only). The encrypted reasoning items
   * captured off the LAST stream, keyed by the function_call `call_id` each
   * precedes. The journal-driven loop reads this AFTER readStream (where
   * pushAssistant is never called) to attach the items to the journaled tool_use
   * entries, so a journal re-projection echoes them before each function_call —
   * stateless reasoning models REQUIRE this on tool turns or the API 400s.
   * Undefined on transports that don't emit reasoning (Anthropic) → the loop's
   * read is a no-op there → byte-identical.
   *
   * PR4 — each item carries an optional `issuer` (the provider/endpoint that minted
   * its `encrypted_content`); the loop journals it so a later turn on a different
   * provider drops the un-decryptable blob (cross-issuer guard).
   *
   * Since 09-23 only the journal-replay transport implements this (its recordings
   * predate the sealed channel). OpenAI Responses carries its reasoning on the `done`
   * event's `replay` instead: a stash on the instance was read by whichever of the
   * parent and its parallel subagents came next (they share one instance), which
   * put one conversation's reasoning into another's history.
   */
  capturedReasoning?():Array<{ callId: string | null; id: string; encryptedContent: string; issuer?: string }>;

  /**
   * OPTIONAL (PR4, OpenAI Responses only). The `invalid_encrypted_content` recovery
   * hook: disables encrypted-reasoning replay for subsequent requests on this
   * transport instance. The loop calls it ONCE (in startStreamWithRetry) when a 400
   * indicates a reasoning blob the current endpoint can't decrypt slipped through the
   * issuer-guard (e.g. an unstamped legacy item), then retries — the request then
   * carries no reasoning and succeeds. Absent on transports without encrypted
   * reasoning (Anthropic) → the loop's call is a no-op.
   */
  disableReasoningReplay?(): void;

  /**
   * OPTIONAL (Anthropic only). The assistant turn's content exactly as the provider
   * sent it (every block, in emission order, unknown types as `provider_raw`),
   * captured off the LAST stream on EVERY round that returned content. The loop
   * reads this AFTER readStream (like capturedReasoning) and rides it onto the
   * assistant journal entry as `anthropicBlocks`, so a journal re-projection sends
   * the signed message back unchanged. Undefined on transports without it → the
   * loop's read is a no-op.
   */
  capturedOrderedBlocks?(): AnthropicReplayBlock[] | undefined;

  /**
   * OPTIONAL (Gemini Interactions only). The assistant turn's ordered steps
   * (thought / text / function_call) captured off the LAST stream, set ONLY when
   * the turn carried a signed `thought` step (stateless Interactions must resend
   * it verbatim). The loop reads this AFTER readStream, like capturedOrderedBlocks,
   * and rides it onto the assistant journal entry as `geminiSteps`. Undefined on
   * every other turn and on every other transport → the loop's read is a no-op →
   * byte-identical.
   */
  capturedGeminiSteps?(): GeminiReplayStep[] | undefined;

  computeCostUsd(usage: NormalizedUsage, model: string): number;
  /**
   * OPTIONAL. True when `computeCostUsd(…, model)` priced at the fail-closed MAXIMUM
   * (openai-pricing.ts FAIL_CLOSED_PRICE) because THIS transport's rate lookup has no
   * row for `model` — an estimate no stop gate may act on (live-spend.ts). Absent ⇒ the
   * transport has no such path (Gemini's family fallback, the fakes) ⇒ its price counts.
   */
  pricedAtFailClosed?(model: string): boolean;
  buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary;
  classifyError(err: unknown): TurnOutcome;
  classifyTermination(a: {
    stopReason: string | null;
    costUsd: number;
    numTurns: number;
    durationMs: number;
    modelUsage: ModelUsageSummary;
    summaryText: string;
  }): TurnOutcome;
  defaultModel(): string;
}

/**
 * A scripted test double — takes an array of StreamEvents, implements the
 * Transport interface. Useful for unit-testing the kernel loop without any
 * real provider SDK.
 */
export class FakeTransport implements Transport {
  readonly api = 'fake';
  readonly provider = 'fake';

  /** Echo of the most recent `callModel({ outputFormat })` (E1 conformance hook). */
  lastOutputFormat: OutputFormat | undefined = undefined;

  /** Echo of the most recent `callModel({ cachePrefixHint })` (K4C-3 D2 hook). */
  lastCachePrefixHint: CachePrefixHint | undefined = undefined;
  /** Every cachePrefixHint seen across calls, in order (so a test can prove the
   *  summarize one-shot was never hinted while the main rounds were). */
  cachePrefixHints: Array<CachePrefixHint | undefined> = [];

  /**
   * Every `callModel({ noCacheWrite })` seen, in order (COMPACTION_V2 hook) — so a
   * test can prove the summarize ONE-SHOT opted out of the prompt cache while every
   * main round did not.
   */
  noCacheWrites: Array<boolean | undefined> = [];
  /** Every `callModel({ reasoningEffort })` seen, in order — so a test can prove a side
   *  call pinned the reasoning floor. */
  reasoningEfforts: Array<'low' | undefined> = [];
  /** Every `callModel({ maxTokens })` seen, in order. */
  maxTokensSeen: number[] = [];
  /** Every `callModel({ system })` seen, in order — lets a test read the summarize
   *  call's system prompt (e.g. that the iterative section was appended). */
  systems: string[] = [];

  /** Echo of the most recent `callModel({ cacheKey })` (OpenAI prompt-cache hook). */
  lastCacheKey: string | undefined = undefined;
  /** Every cacheKey seen across calls, in order (so a test can prove the main
   *  per-turn calls were anchored while the side-calls were not). */
  cacheKeys: Array<string | undefined> = [];

  constructor(private readonly events: StreamEvent[]) {}

  emptyHistory(): ProviderHistory {
    return [];
  }

  historyFromJournal(_entries: JournalEntry[]): ProviderHistory {
    return [];
  }

  pushAssistant(h: ProviderHistory, _blocks: ContentBlock[]): void {
    (h as unknown[]).push({ role: 'assistant' });
  }

  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    (h as unknown[]).push({ role: 'tool', toolUseId: r.toolUseId });
  }

  pushUser(h: ProviderHistory, text: string, _images?: ImageBlock[], _media?: MediaBlock[]): void {
    (h as unknown[]).push({ role: 'user', text });
  }

  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    return raw as ProviderTool[];
  }

  callModel(p: {
    model: string;
    system: string;
    tools: ProviderTool[];
    history: ProviderHistory;
    signal?: AbortSignal;
    maxTokens: number;
    outputFormat?: OutputFormat;
    cachePrefixHint?: CachePrefixHint;
    cacheKey?: string;
    noCacheWrite?: boolean;
    reasoningEffort?: 'low';
  }): ProviderStream {
    this.noCacheWrites.push(p.noCacheWrite);
    this.reasoningEfforts.push(p.reasoningEffort);
    this.maxTokensSeen.push(p.maxTokens);
    this.systems.push(p.system);
    this.lastOutputFormat = p.outputFormat;
    this.lastCachePrefixHint = p.cachePrefixHint;
    this.cachePrefixHints.push(p.cachePrefixHint);
    this.lastCacheKey = p.cacheKey;
    this.cacheKeys.push(p.cacheKey);
    return this.events;
  }

  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    for (const ev of stream as StreamEvent[]) {
      yield ev;
    }
  }

  computeCostUsd(_usage: NormalizedUsage, _model: string): number {
    return 0.001;
  }

  buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary {
    return {
      [model]: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        webSearchRequests: 0,
        costUSD: 0.001,
      },
    };
  }

  classifyError(err: unknown): TurnOutcome {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'model_error',
      message,
      raw: { subtype: 'fake_error', errors: [message] },
    };
  }

  classifyTermination(a: {
    stopReason: string | null;
    costUsd: number;
    numTurns: number;
    durationMs: number;
    modelUsage: ModelUsageSummary;
    summaryText: string;
  }): TurnOutcome {
    return {
      kind: 'completed',
      summary: a.summaryText,
      costUsd: a.costUsd,
      numTurns: a.numTurns,
      durationMs: a.durationMs,
      modelUsage: a.modelUsage,
      raw: { subtype: 'fake_completed', errors: [] },
    };
  }

  defaultModel(): string {
    return 'fake';
  }
}

/**
 * UnsetTransport — the neutral field default a `NativeHarness` carries BEFORE
 * `run()` installs the run's real `Transport` (ring 4c.9). The SDK engine no
 * longer defaults `NativeHarness.transport` to a concrete provider port
 * (`AnthropicMessagesTransport` was the product-side poison edge), so the field
 * starts as this inert placeholder.
 *
 * Its `classifyError` returns a GENERIC classified failure (a `model_error`) —
 * it does NOT delegate to any provider — so a `NativeHarness` constructed but
 * never `run()` still classifies via a valid (if uninformative) `TurnOutcome`
 * rather than NPE-ing on a null transport. Every I/O method throws: reaching one
 * means the loop drove the port before `run()` set the real transport, which is
 * a programmer error, not a recoverable runtime condition. `run()` ALWAYS
 * replaces this with `ctx.config.transport` (required), so these never fire in
 * the real loop.
 */
export class UnsetTransport implements Transport {
  readonly api = 'unset';
  readonly provider = 'unset';

  private fail(method: string): never {
    throw new Error(`UnsetTransport.${method} called before NativeConfig.transport was installed`);
  }

  emptyHistory(): ProviderHistory {
    return this.fail('emptyHistory');
  }

  historyFromJournal(_entries: JournalEntry[]): ProviderHistory {
    return this.fail('historyFromJournal');
  }

  pushAssistant(_h: ProviderHistory, _blocks: ContentBlock[]): void {
    this.fail('pushAssistant');
  }

  pushToolResult(_h: ProviderHistory, _r: ToolDispatchResult): void {
    this.fail('pushToolResult');
  }

  pushUser(_h: ProviderHistory, _text: string, _images?: ImageBlock[], _media?: MediaBlock[]): void {
    this.fail('pushUser');
  }

  buildTools(_raw: RawToolOptions[]): ProviderTool[] {
    return this.fail('buildTools');
  }

  callModel(_p: {
    model: string;
    system: string;
    tools: ProviderTool[];
    history: ProviderHistory;
    signal?: AbortSignal;
    maxTokens: number;
    outputFormat?: OutputFormat;
    cachePrefixHint?: CachePrefixHint;
    cacheKey?: string;
  }): ProviderStream {
    return this.fail('callModel');
  }

  readStream(_stream: ProviderStream): AsyncIterable<StreamEvent> {
    return this.fail('readStream');
  }

  computeCostUsd(_usage: NormalizedUsage, _model: string): number {
    return this.fail('computeCostUsd');
  }

  buildModelUsage(_usage: NormalizedUsage, _model: string): ModelUsageSummary {
    return this.fail('buildModelUsage');
  }

  /**
   * A generic classified failure — does NOT delegate to any provider. The
   * placeholder transport cannot meaningfully classify a real upstream error,
   * so it surfaces a neutral `model_error` (never-throw preserved).
   */
  classifyError(err: unknown): TurnOutcome {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'model_error',
      message,
      raw: { subtype: 'unset_transport', errors: [message] },
    };
  }

  classifyTermination(a: {
    stopReason: string | null;
    costUsd: number;
    numTurns: number;
    durationMs: number;
    modelUsage: ModelUsageSummary;
    summaryText: string;
  }): TurnOutcome {
    return {
      kind: 'completed',
      summary: a.summaryText,
      costUsd: a.costUsd,
      numTurns: a.numTurns,
      durationMs: a.durationMs,
      modelUsage: a.modelUsage,
      raw: { subtype: 'unset_transport', errors: [] },
    };
  }

  defaultModel(): string {
    return this.fail('defaultModel');
  }
}

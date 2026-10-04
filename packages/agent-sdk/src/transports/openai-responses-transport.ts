/**
 * OpenAIResponsesTransport — the `Transport` (ModelPort) for the native OpenAI
 * Responses API arm.
 *
 * The structural twin of `AnthropicMessagesTransport`, swapped to the OpenAI
 * Responses API wire dialect. It is a THIN seam: it does NOT reimplement any
 * Responses logic — it DELEGATES to the already-tested K2 pieces:
 *   - openai-responses-messages  (journal → input, the streaming accumulator)
 *   - openai-responses-pricing   (cost + ModelUsageSummary)
 *   - openai-responses-termination (error + termination classification)
 *
 * Provider history is `OpenAI.Responses.ResponseInputItem[]` (the loop treats it
 * as the opaque `ProviderHistory`); the stream is the live `ResponseStream`
 * handle. The kernel loop drives `Transport` and never imports an SDK.
 */

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import type { JournalEntry } from '../contract/journal.js';
import type { ModelUsageSummary, TurnOutcome } from '../contract/turn-outcome.js';
import type { OutputFormat } from '../contract/output-format.js';
import type { RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';
import { withNarrationParam } from '../engine/tool-dispatcher.js';
import {
  journalToOpenAIResponsesInput,
  createOpenAIResponsesAccumulator,
  blocksToOpenAIResponsesContent,
  toolResultOutput,
  sealedResponsesItems,
} from './openai-responses-messages.js';
import { preflightOpenAIResponsesInput } from '../engine/request-validity.js';
import { computeOpenAIResponsesCostUsd, buildModelUsage } from './openai-responses-pricing.js';
import { pricesAtFailClosed } from '../contract/openai-pricing.js';
import {
  classifyOpenAIResponsesError,
  OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE,
  classifyOpenAIResponsesTermination,
} from './openai-responses-termination.js';
import { resolveOpenAIReasoning } from './thinking-support.js';
import { mediaFileIdOpenAIEnabled, toolsMidstreamEnabled } from '../policy/feature-flags.js';
import { modelResponseTimeout } from '../engine/error-authority.js';
import { materializeOpenAIFileIds, hasHttpsInputImages } from './openai-file-materialize.js';
import { toOpenAIToolJsonSchema } from './openai-tool-schema.js';
import { isOpenAIStrictCompatible } from '../contract/openai-strict-schema.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderReplay,
  ProviderStream,
  ProviderTool,
  StreamEvent,
  Transport,
} from '../engine/transport.js';
import { resolveCapabilities, type ModelProvider } from '../contract/model-capabilities.js';
import { cutMemorySpan, type MemorySpan } from '../contract/instruction-stack.js';
import { fenceSessionMemory } from '../contract/injected-user-text.js';
import { readsCacheAtBoundaries } from '../contract/openai-cache-boundaries.js';
import { openAIClientFor, openAICredentialKey, openAILaneBase } from './openai-endpoints.js';
import { apiPlaneRoute, LaneMove } from './lane-fallback.js';
import { prewarmBaseUrl } from './warm-connections.js';

/**
 * Map a RawToolOptions → the OpenAI Responses function-tool shape.
 *
 * Two parts, both required to make tool-arg generation correct on the OpenAI arm
 * (see openai-tool-schema.ts for the full rationale + the 400-trap):
 *   - `parameters`: ALWAYS the Zod schema CONVERTED to JSON Schema. The raw Zod
 *     object has no `properties`/`required`, so OpenAI invents argument keys
 *     (the founder-reproduced Skill `{skill}`-vs-`{name}` crash). This fix lands
 *     for every tool, even at strict:false.
 *   - `strict`: honor `o.strict` ONLY when the CONVERTED schema is provably
 *     OpenAI-strict-compatible. A tool with an optional/`.nullable()` field (or a
 *     `z.record`) is NOT strict-compatible, and `strict:true` on it would 400 the
 *     ENTIRE request — so those are sent strict:false WITH their real schema. This
 *     can never introduce a 400.
 */
function toOpenAIResponsesTool(o: RawToolOptions): OpenAI.Responses.FunctionTool {
  const parameters = toOpenAIToolJsonSchema(o.parameters);
  return {
    type: 'function',
    name: o.name,
    description: o.description,
    parameters,
    strict: (o.strict ?? false) && isOpenAIStrictCompatible(parameters),
  };
}

/**
 * Map the provider-neutral OutputFormat → the OpenAI Responses `text.format`
 * shape (constrained decoding). `strict:true` is the whole point — it enables
 * Structured Outputs. OpenAI REQUIRES a `name` (a-z/0-9/_/-, ≤64 chars); the
 * contract's `name` is optional, so fall back to a stable default.
 */
function toResponsesTextFormat(fmt: OutputFormat): OpenAI.Responses.ResponseTextConfig {
  return {
    format: {
      type: 'json_schema',
      strict: true,
      name: fmt.name ?? 'structured_output',
      schema: fmt.schema as { [key: string]: unknown },
    },
  };
}

/** The ResponseStream slice the loop touches: an async-iterable of stream events. */
type ResponsesStreamHandle = AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;

export interface OpenAIResponsesTransportOptions {
  /** Inject a (mock) OpenAI client for tests — avoids any real API call. */
  client?: OpenAI;
  /**
   * Lazy per-provider client factory (injected by tests that assert a
   * construction throw surfaces inside callModel, and that the right
   * base/key is chosen per provider). Absent → openAIClientFor (openai-endpoints.ts) is used.
   */
  createClient?: (provider: ModelProvider, baseOverride?: string) => OpenAI;
}

/**
 * The cache route a call with no `cacheKey` belongs to. Keyless calls send no
 * `prompt_cache_key`, so they share one provider-side cache and one pin.
 */
const GLOBAL_CACHE_ROUTE = '__global__';

/** How many cache-route pins the prefix guard retains. See guardSystemPrefix. */
const MAX_TRACKED_CACHE_ROUTES = 256;

export class OpenAIResponsesTransport implements Transport {
  readonly api = 'openai_responses';
  readonly provider = 'openai';

  /** Injected concrete client (tests) — short-circuits the per-provider cache. */
  private readonly injectedClient: OpenAI | undefined;
  /** One lazily-built client per provider value. */
  private readonly clientsByProvider = new Map<ModelProvider, { client: OpenAI; credential: string | undefined; route?: string }>();   // credential = its sha256 (openAICredentialKey)
  private readonly createClient: (provider: ModelProvider, baseOverride?: string) => OpenAI;
  /** LANE_FALLBACK_V1: each provider's move to its second route, while it holds. */
  private readonly laneMoves = new Map<ModelProvider, LaneMove>();

  /**
   * PR4 — the provider/issuer each stream was opened against (the endpoint that
   * mints its `encrypted_content`), stamped onto that round's sealed output so a
   * later turn on a different provider drops the un-decryptable blob. Keyed by the
   * STREAM, never a last-call slot: the parent and its parallel subagents share this
   * instance, so "the last callModel" is someone else's call half the time.
   */
  private readonly issuerByStream = new WeakMap<object, string>();

  /**
   * PR4 — the `invalid_encrypted_content` kill switch. Default true (replay encrypted
   * reasoning). Flipped false by `disableReasoningReplay()` after a 400 slips through
   * (e.g. an unstamped legacy blob the issuer-guard couldn't proactively drop); the
   * preflight then drops ALL reasoning so the retry succeeds.
   */
  private replayReasoning = true;

  /** PR5 item 3 — the first `instructions` (system) prefix hash seen PER CACHE ROUTE, for the cache-mutation guard. */
  private readonly expectedSystemHashByRoute = new Map<string, string>();

  constructor(opts: OpenAIResponsesTransportOptions = {}) {
    this.injectedClient = opts.client;
    this.createClient = opts.createClient ?? openAIClientFor;
  }

  /**
   * Lazily build (and memoize, per provider and credential) the client for a provider. An injected concrete
   * client wins for every provider. A factory throw (e.g. missing key)
   * propagates to the caller so run() classifies it.
   */
  private getClient(provider: ModelProvider): OpenAI {
    if (this.injectedClient) return this.injectedClient;
    // Keyed by the credential as well: a run stays warm across turns (and across a box's
    // freeze), and the runner's token refresh swaps process.env, never a client already built.
    // A client holding the old token 401s every turn once it expires (staging 2026-10-02).
    const credential = openAICredentialKey(provider);
    const route = this.laneMoves.get(provider)?.current();
    const memo = this.clientsByProvider.get(provider);
    if (memo && memo.credential === credential && memo.route === route) return memo.client;
    const client = route === undefined ? this.createClient(provider) : this.createClient(provider, route);
    this.clientsByProvider.set(provider, { client, credential, ...(route !== undefined && { route }) });
    return client;
  }

  /** LANE_FALLBACK_V1: `model`'s provider moves to the same proxy route on the API plane while the move holds. */
  fallBackLane(model: string, until?: number): boolean {
    if (this.injectedClient) return false;
    const provider = resolveCapabilities(model).provider;
    let move = this.laneMoves.get(provider);
    if (move === undefined) this.laneMoves.set(provider, (move = new LaneMove()));
    return move.move(apiPlaneRoute(provider, openAILaneBase(provider)), until);
  }

  /** WARM_CONNECTIONS_V1: open the connection `model`'s next request will ride. */
  prewarm(model: string): void {
    prewarmBaseUrl(() => this.getClient(resolveCapabilities(model).provider).baseURL);
  }

  emptyHistory(): ProviderHistory {
    return [] as OpenAI.Responses.ResponseInputItem[];
  }

  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return journalToOpenAIResponsesInput(entries);
  }

  pushAssistant(h: ProviderHistory, blocks: ContentBlock[], replay?: ProviderReplay): void {
    const items = h as OpenAI.Responses.ResponseInputItem[];
    // SEALED: the round's `response.output` exactly as the provider returned it (the
    // `done` event's replay) — its reasoning where the model put it, every message
    // with its id and `phase`, the raw `arguments`. The rebuild below has none of
    // that, and its old reasoning carry lived on THIS instance: a parallel subagent
    // sharing it drained a sibling's (another conversation's) reasoning into its own
    // history (09-23 audit). The rebuild is now only the fallback for a round with
    // no replay, and carries no reasoning at all.
    if (replay && !Array.isArray(replay) && replay.dialect === 'openai_responses' && replay.output.items.length > 0) {
      items.push(...sealedResponsesItems(replay.output));
      return;
    }
    // text blocks → one assistant message item; each tool_use block → a
    // function_call item (mirrors anthropic-transport.pushAssistant, swapped to
    // the Responses input shapes). tool_use arrives as the neutral ContentBlock
    // ToolUseBlock shape (toolUseId / toolName / toolInput).
    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) items.push({ role: 'assistant', content: text });
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        items.push({
          type: 'function_call',
          call_id: b.toolUseId,
          name: b.toolName,
          arguments: b.toolInput === undefined ? '{}' : JSON.stringify(b.toolInput),
        });
      }
    }
  }

  /**
   * PR4 — the `invalid_encrypted_content` recovery hook. The harness calls this once
   * (in startStreamWithRetry) when a 400 indicates an un-decryptable reasoning blob
   * slipped through the issuer-guard (e.g. an unstamped legacy item); the next request
   * drops ALL reasoning via the preflight kill switch, so the retry succeeds.
   */
  disableReasoningReplay(): void {
    this.replayReasoning = false;
  }

  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    // When the dispatch result carries image blocks (browser-control screenshots),
    // emit the content-ARRAY `output` (input_text part(s) + input_image part(s));
    // otherwise keep `output: r.text` as a bare string (byte-identical).
    // `toolResultOutput` is the SAME helper the journal converter uses, so the two
    // paths can't drift — and the text-only fallback stays `r.text` exactly (this
    // path's existing text source).
    (h as OpenAI.Responses.ResponseInputItem[]).push({
      type: 'function_call_output',
      call_id: r.toolUseId,
      output: toolResultOutput(r.blocks ?? [], r.text),
    });
  }

  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], _media?: MediaBlock[]): void {
    const items = h as OpenAI.Responses.ResponseInputItem[];
    if (images?.length) {
      // Project images + text through the SAME helper the journal path uses, so the
      // in-memory turn and a journal re-projection cannot drift. The helper orders
      // image-before-text (parity with AnthropicMessagesTransport.pushUser) and only
      // adds a text part when `text` is non-empty.
      const blocks: ContentBlock[] = [
        ...images,
        ...(text ? [{ type: 'text' as const, text }] : []),
      ];
      items.push({ role: 'user', content: blocksToOpenAIResponsesContent(blocks) });
      return;
    }
    // No images — bare string, byte-identical to before.
    items.push({ role: 'user', content: text });
  }

  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    // Narration parity: same injection seam as the Anthropic arm (story spine
    // mint ladder tier-1). The dispatcher strips it before execution.
    return raw.map((o) => toOpenAIResponsesTool(withNarrationParam(o)));
  }

  /**
   * PR5 item 3 — pin the first `instructions` (system) prefix seen ON EACH CACHE
   * ROUTE; warn LOUD (once, non-fatal) on any later drift within that route. Parity
   * with AnthropicMessagesTransport.guardSystemPrefix: OpenAI's automatic prefix
   * cache is byte-prefix-based, so a mutated system prefix silently routes to a
   * fresh shard and reads nothing — strictly worse than no caching. PURE; NEVER
   * throws (observability only). The Anthropic arm never reaches this code.
   *
   * KEYED BY `cacheKey` — the value this arm sends as `prompt_cache_key`, i.e. the
   * literal provider-side cache route — rather than pinned once per instance. One
   * instance serves a whole run, and a run's off-loop side-calls (compaction /
   * suggestion / vision) each carry their OWN system prompt, so a single slot
   * reported every switch between lanes as drift: the 2026-08-24 burn log's
   * [CACHE_PROMPT_MUTATED] warns were all that, hashes ping-ponging pairwise. Two
   * lanes can only mask each other's drift when they share a route, which is
   * exactly when a mutated prefix would actually cost a cache read.
   */
  private guardSystemPrefix(system: string, cacheKey: string | undefined): void {
    const route = cacheKey ?? GLOBAL_CACHE_ROUTE;
    const hash = createHash('sha256').update(system).digest('hex').slice(0, 12);
    const pinned = this.expectedSystemHashByRoute.get(route);
    if (pinned === undefined) {
      this.expectedSystemHashByRoute.set(route, hash); // pin on the route's first turn
      // Oldest-first eviction, NOT LRU: a route is one task/session/side-lane and
      // 256 is far beyond the routes one runner process holds live at once, so the
      // entry dropped is one nothing calls again. Evicting a live route costs a
      // silent re-pin (one missed drift warn), never a false one.
      if (this.expectedSystemHashByRoute.size > MAX_TRACKED_CACHE_ROUTES) {
        const oldest = this.expectedSystemHashByRoute.keys().next().value;
        if (oldest !== undefined) this.expectedSystemHashByRoute.delete(oldest);
      }
      return;
    }
    if (hash !== pinned) {
      console.warn(
        `[CACHE_PROMPT_MUTATED] openai system prefix drifted: expected=${pinned} ` +
          `actual=${hash}. Something dynamic leaked into the cached prefix — cache reads will miss. ` +
          `Move per-turn content into the journal-projected messages (after the system breakpoint).`,
      );
      // Re-pin so we warn ONCE per drift, not on every subsequent turn.
      this.expectedSystemHashByRoute.set(route, hash);
    }
  }

  callModel(p: {
    model: string;
    system: string;
    tools: ProviderTool[];
    history: ProviderHistory;
    signal?: AbortSignal;
    maxTokens: number;
    outputFormat?: OutputFormat;
    cacheKey?: string;
    /**
     * OPTIONAL OpenAI output-verbosity knob (PR5 item 4). Merged into the
     * Responses `text` object. Absent (default undefined) ⇒ no `verbosity` key ⇒
     * request body byte-identical. The Anthropic arm never reaches this code.
     */
    verbosity?: 'low' | 'medium' | 'high';
    reasoningEffort?: 'low';
    systemMemorySpan?: MemorySpan;
  }): ProviderStream {
    // RESPONSES_MEMORY_INPUT_V1: on a build that reads the cache only at lookup boundaries
    // (openai-cache-boundaries.ts), the per-task memory leaves `instructions` and rides as the
    // first user input item, fenced as recall is, so the developer block holds only what a
    // person's tasks share (the deferred-tool index after the memory stays in it).
    const cut = readsCacheAtBoundaries(p.model) ? cutMemorySpan(p.system, p.systemMemorySpan) : undefined;
    const instructions = cut ? cut.rest : p.system;
    const memoryInput: OpenAI.Responses.ResponseInputItem[] = cut
      ? [{ role: 'user', content: [{ type: 'input_text', text: fenceSessionMemory(cut.memory) }] }]
      : [];
    this.guardSystemPrefix(instructions, p.cacheKey);
    // Reasoning — enabled ONLY when the model is reasoning-capable (gpt-5.x /
    // o-series) AND OPENAI_REASONING is on. `summary:'auto'` streams a human-
    // readable reasoning summary we surface as `thinking`. Omitted (null) for
    // non-reasoning models → no break.
    const resolvedReasoning = resolveOpenAIReasoning(p.model);
    // A side call may pin the floor (the memory sweep): same summary, least effort. Never
    // invents a reasoning block the kill switch or a non-reasoning row left out.
    const reasoning =
      resolvedReasoning && p.reasoningEffort ? { ...resolvedReasoning, effort: p.reasoningEffort } : resolvedReasoning;
    // Structured output (P6 E3): the terminal constrained call carries the
    // schema as Responses constrained decoding (`text.format`, strict). Absent
    // ⇒ no `text` key ⇒ request body byte-identical (the unconstrained loop).
    // PR5 item 4: an OPTIONAL `verbosity` knob rides on the SAME `text` object.
    // Build `text` only when EITHER is present; when both are absent it stays
    // undefined ⇒ no `text` key ⇒ byte-identical. Conditional spreads keep each
    // sub-key out of the object when its source is absent.
    const text: OpenAI.Responses.ResponseTextConfig | undefined =
      p.outputFormat || p.verbosity
        ? {
            ...(p.outputFormat ? toResponsesTextFormat(p.outputFormat) : {}),
            ...(p.verbosity ? { verbosity: p.verbosity } : {}),
          }
        : undefined;
    // Provider-value lookup — NOT a runtime/HarnessId branch (no lint-wall violation).
    const caps = resolveCapabilities(p.model);
    const provider = caps.provider;
    // §4.3a — stateless reasoning models REQUIRE the encrypted reasoning item to be
    // returned and echoed back on tool turns, or the Responses API errors. Request it
    // ONLY for reasoning models (gate on the registry) so non-reasoning ids stay
    // byte-identical (no `include` key sent). The Anthropic arm never reaches this
    // code, so its wire path is untouched.
    const isReasoning = caps.thinking.mode === 'reasoning';
    // PR4 — gate `include` on the replay kill switch too (Hermes ties them together).
    // Once replay is disabled (invalid_encrypted_content recovery), the preflight drops
    // ALL reasoning from input, so asking the endpoint to RETURN encrypted reasoning
    // would only mint dead blobs we capture, journal, and strip again next turn.
    const include = isReasoning && this.replayReasoning
      ? (['reasoning.encrypted_content'] as OpenAI.Responses.ResponseIncludable[])
      : undefined;
    // PR3 — the raising stateless preflight: strip reasoning `id`s (store:false →
    // they 404), dedup reasoning by id, and assert call_id/name on tool items.
    // Applied HERE (the single choke point) so BOTH the journal-projected and the
    // in-memory `pushAssistant` histories get it uniformly.
    const preflighted = preflightOpenAIResponsesInput(
      p.history as OpenAI.Responses.ResponseInputItem[],
      {
        // PR4 — drop reasoning blobs minted by a DIFFERENT provider (un-decryptable
        // → 400), and honor the invalid_encrypted_content kill switch.
        currentIssuer: provider,
        replayReasoning: this.replayReasoning,
      },
    );
    const startStream = (wireInput: OpenAI.Responses.ResponseInputItem[]) =>
      this.getClient(provider).responses.stream(
      {
        model: p.model,
        instructions,
        tools: p.tools as OpenAI.Responses.Tool[],
        input: cut ? [...memoryInput, ...wireInput] : wireInput,
        max_output_tokens: p.maxTokens,
        ...(reasoning ? { reasoning } : {}),
        ...(include ? { include } : {}),
        ...(text ? { text } : {}),
        // PR3 (Hermes parity) — STATELESS contract. `store` defaults to TRUE on the
        // Responses API, which (a) retains every conversation server-side (a privacy
        // regression — we send full input each turn and never use previous_response_id,
        // so retention buys nothing) and (b) is INCOMPATIBLE with replaying encrypted
        // reasoning by `id`: with store:true the API resolves the id server-side, but
        // the instant store is correctly false those ids 404. We pin store:false and
        // strip reasoning `id`s on the wire (preflightOpenAIResponsesInput), replaying
        // the self-contained `encrypted_content` blob instead. Mirrors Hermes' codex.py
        // build_kwargs `store:False`. The Anthropic arm never reaches this code.
        store: false,
        // OpenAI prompt-caching anchor. A stable per-task key gives OpenAI's
        // automatic prefix cache deliberate cross-request affinity (the system
        // prefix is stable + >1024 tokens, so the cache CAN hit; this routes every
        // turn of a task to the same shard so it DOES hit). Conditional spread —
        // absent ⇒ no `prompt_cache_key` key (the contract-level byte-identity guard).
        ...(p.cacheKey ? { prompt_cache_key: p.cacheKey } : {}),
      },
      { signal: p.signal, ...modelResponseTimeout() },
      );

    // Media-refs S1 (flag-gated): https input_image urls → uploaded file_id
    // (purpose vision; data-url fallback — never rely on OpenAI's server-side
    // url fetch). Canonical history keeps the url form; only the wire copy is
    // substituted. The lazy generator defers the async upload to the first
    // stream read, so callModel stays sync and the flag-off/no-image path
    // returns the raw stream byte-identically.
    // PR4 — this stream's issuer: stamped onto its sealed output by readStream.
    const opened = (): ProviderStream => {
      if (mediaFileIdOpenAIEnabled() && hasHttpsInputImages(preflighted)) {
        const client = this.getClient(provider);
        return (async function* () {
          const wireInput = await materializeOpenAIFileIds(preflighted, client);
          yield* startStream(wireInput) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
        })();
      }
      return startStream(preflighted);
    };
    const stream = opened();
    if (stream !== null && typeof stream === 'object') this.issuerByStream.set(stream, provider);
    return stream;
  }

  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const s = stream as ResponsesStreamHandle;
    const acc = createOpenAIResponsesAccumulator();

    // Live pass: feed every event to the accumulator, surfacing text + reasoning-
    // summary (thinking) deltas as they stream. The reasoning summary renders
    // through the SAME AGENT_THINKING_DELTA wiring as the Anthropic arm. OpenAI
    // reasoning carries no replayable signature, so after the live deltas we emit a
    // DISPLAY-ONLY `thinking_block` (signature omitted, PR4 P3) to PERSIST the
    // summary for reload — it is never echoed on the wire (the encrypted carry is the
    // sole wire-replay source). The Responses API does not require replaying the
    // prior summary on the next request.
    // Track whether the refusal text streamed live (via refusal deltas) so we can
    // emit it once at the end if it arrived ONLY on the finalized message item
    // (the belt-and-suspenders path has no delta events).
    let refusalStreamed = false;
    // L1 (TOOLS_MIDSTREAM_V1): a call is ready when its arguments are done. Off: no event.
    const midstream = toolsMidstreamEnabled();
    for await (const ev of s) {
      acc.onEvent(ev);
      // Signal the OPEN of a reasoning block BEFORE its summary streams (the
      // reasoning output item is added first) — arm parity with the Anthropic
      // `content_block_start` thinking_start, so the UI mounts the thinking pill
      // the moment reasoning begins rather than on the first summary fragment.
      if (ev.type === 'response.output_item.added' && ev.item?.type === 'reasoning') {
        yield { kind: 'thinking_start' };
      }
      const think = acc.thinkingDelta(ev);
      if (think !== null) yield { kind: 'thinking', text: think };
      const delta = acc.textDelta(ev);
      if (delta !== null) yield { kind: 'text', text: delta };
      // A soft refusal renders live through the SAME AGENT_TEXT_DELTA wiring as
      // ordinary text — the user must SEE the refusal, not a blank bubble.
      const refusal = acc.refusalDelta(ev);
      if (refusal !== null) {
        refusalStreamed = true;
        yield { kind: 'text', text: refusal };
      }
      if (midstream) for (const toolUse of acc.takeReady()) yield { kind: 'tool_ready', toolUse };
    }

    // Surface an ABNORMAL end instead of fabricating a clean empty `done`. The live
    // loop above won't have thrown for two failure shapes: a `response.failed` /
    // top-level `error` SSE event (e.g. an `insufficient_quota` reaching us through
    // the credential proxy as a stream event), or a stream that simply drains with
    // NO terminal event at all. In both cases re-throw a CLASSIFIABLE error so the
    // harness routes it through classifyError → a visible terminal reason, rather
    // than the old silent `usage:{0,0}` "completed" turn that rendered as a $0
    // no-response. (A normal turn always ends in response.completed/.incomplete, so
    // a null `final` here is by definition not a success.)
    const failure = acc.failure();
    if (failure) {
      throw Object.assign(
        new Error(failure.message),
        failure.code != null ? { code: failure.code } : {},
      );
    }
    const final = acc.final();
    if (final === null) {
      // The SSE ended with no terminal event — the premature-end sentinel. Under
      // NATIVE_STREAM_SEVERED_RETRY this classifies as a SEVERANCE (network_error /
      // 'stream_severed') so the engine seals the partial and re-issues the round
      // instead of burning the turn; the message lives in the ONE named constant
      // the classifier matches on.
      throw new Error(OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE);
    }

    // Belt-and-suspenders: a refusal that arrived ONLY on the finalized message
    // item (no delta events) never streamed live — emit it as a synthetic text
    // block now so the refusal still renders, and so the harness folds it into the
    // turn blocks that `summarize` feeds into classifyTermination's summaryText.
    const refusalText = acc.refusal();
    if (!refusalStreamed && refusalText !== '') {
      yield { kind: 'text', text: refusalText };
    }

    // PR4 P3 — persist the reasoning summary as a DISPLAY-ONLY thinking_block
    // (signature OMITTED), AFTER the live `thinking` deltas, symmetric with the
    // Anthropic arm (anthropic-transport.ts thinking_block emission). The engine
    // collects this into `thinkingBlocks` → folds it into the assistant journal
    // entry's blocks → it renders on reload. It is NEVER replayed as a wire reasoning
    // item: the OpenAI journal/in-memory projections drop thinking from the wire, and
    // an unsigned thinking block is never echoed — only the sealed `output` (below)
    // is replayed on the wire. So there is exactly ONE wire-replay source and no
    // double-echo. Omitted entirely when there was no summary
    // (non-reasoning / no-summary turn → byte-identical to the pre-P3 stream).
    const summary = acc.reasoningSummary();
    if (summary !== '') {
      yield { kind: 'thinking_block', thinking: summary };
    }

    // The full turn is now accumulated: emit each captured tool_use, then `done`.
    for (const tu of acc.toolUses()) {
      yield { kind: 'tool_use', toolUse: { id: tu.id, name: tu.name, input: tu.input } };
    }

    // SEALED: the provider's own `response.output` for this round rides the done
    // event (see pushAssistant); every reader gets its own round's copy.
    const items = acc.output();
    const issuer = this.issuerByStream.get(stream as object);
    yield {
      kind: 'done',
      stopReason: final.stopReason,
      usage: final.usage,
      ...(items ? { replay: { dialect: 'openai_responses' as const, output: { items, ...(issuer ? { issuer } : {}) } } } : {}),
    };
  }

  computeCostUsd(usage: NormalizedUsage, model: string): number {
    return computeOpenAIResponsesCostUsd(usage, model);
  }

  pricedAtFailClosed(model: string): boolean {
    return pricesAtFailClosed(model);
  }

  buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary {
    return buildModelUsage(usage, model);
  }

  classifyError(err: unknown): TurnOutcome {
    return classifyOpenAIResponsesError(err);
  }

  classifyTermination(a: {
    stopReason: string | null;
    costUsd: number;
    numTurns: number;
    durationMs: number;
    modelUsage: ModelUsageSummary;
    summaryText: string;
  }): TurnOutcome {
    return classifyOpenAIResponsesTermination(a);
  }

  /** CONTEXT_APPEND_V1 (C7): the effort a loop request sends, from the request's own resolver. */
  reasoningEffort(model: string): string | undefined {
    return resolveOpenAIReasoning(model)?.effort;
  }

  defaultModel(): string {
    // Terra retired 2026-09-23 for GPT-6 Sol, which GPT-6.1 Sol replaced 2026-09-30.
    return 'gpt-6.1-sol';
  }
}

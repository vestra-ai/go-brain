/**
 * ChatCompletionsTransport — the `Transport` (ModelPort) for the OpenAI Chat
 * Completions wire dialect.
 *
 * This is the BREADTH transport: one dialect fronts every OpenAI-compatible
 * provider (OpenAI, DeepSeek, Kimi/Moonshot, MiniMax, Groq, Together, OpenRouter,
 * local servers) via `OPENAI_BASE_URL`. Structural twin of OpenAIResponsesTransport,
 * swapped to the Chat Completions shapes; it delegates to:
 *   - chat-completions-messages  (journal → messages, the streaming accumulator)
 *   - openai-responses-pricing   (reused cost + ModelUsageSummary — same model ids)
 *   - openai-responses-termination (reused OpenAI error classification)
 *   - native-termination         (shared stopReason → outcome, fed a mapped reason)
 *
 * Provider history is `ChatCompletionMessageParam[]` (opaque `ProviderHistory` to
 * the loop); the stream is an async-iterable of `ChatCompletionChunk`.
 */

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import { fireworksWireId, rendersToolsAfterSystem } from '../contract/fireworks-wire.js';
import { cutMemorySpan, type MemorySpan } from '../contract/instruction-stack.js';
import type { JournalEntry } from '../contract/journal.js';
import type { ModelUsageSummary, TurnOutcome } from '../contract/turn-outcome.js';
import type { RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';
import { withNarrationParam } from '../engine/tool-dispatcher.js';
import {
  journalToChatCompletionsMessages,
  createChatCompletionsAccumulator,
  blocksToChatContent,
  stripImagesFromChatMessages,
  toolResultText,
  withReasoning,
  withoutReasoningContent,
  deepseekReasoningEffort,
  type ImageNoteOpts,
} from './chat-completions-messages.js';
import { mediaInlineChatEnabled, toolsMidstreamEnabled, toolSchemaCompactEnabled } from '../policy/feature-flags.js';
import { modelResponseTimeout } from '../engine/error-authority.js';
import { expandNullableStringTypes } from '../contract/tool-json-schema.js';

/**
 * Note-enrichment opts for every blind-lane note site (journal replay, live
 * tool results, the per-request strip): S1 naming. ONE mint site so the three
 * call sites can never disagree about what a note says. Flag off ⇒
 * `{named:false}` ⇒ every note byte-identical to today.
 */
function noteOpts(): ImageNoteOpts {
  return { named: mediaInlineChatEnabled() };
}
import { inlineChatImageParts, hasHttpsChatImages } from './chat-completions-inline.js';
import { computeOpenAIResponsesCostUsd, buildModelUsage } from './openai-responses-pricing.js';
import { pricesAtFailClosed } from '../contract/openai-pricing.js';
import {
  classifyOpenAIResponsesError,
  CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE,
} from './openai-responses-termination.js';
import { classifyAnthropicTermination } from '../engine/native-termination.js';
import { withSendableToolArguments } from '../engine/request-validity.js';
import { toOpenAIToolJsonSchema } from './openai-tool-schema.js';
import { sanitizeMoonshotToolParameters, isMoonshotModel } from './chat-completions-moonshot-schema.js';
import { isOpenAIStrictCompatible } from '../contract/openai-strict-schema.js';
import { resolveCapabilities, type ModelProvider } from '../contract/model-capabilities.js';
import { openAIClientFor, openAICredentialKey, openAILaneBase } from './openai-endpoints.js';
import { apiPlaneRoute, LaneMove } from './lane-fallback.js';
import { prewarmBaseUrl } from './warm-connections.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderReplay,
  ProviderStream,
  ProviderTool,
  StreamEvent,
  Transport,
} from '../engine/transport.js';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type AssistantMsg = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
type ChunkStream = AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

/** Map a RawToolOptions → the Chat Completions function-tool shape (same JSON-schema
 *  conversion + strict-safety gate as the Responses arm; see openai-tool-schema). */
function toChatTool(o: RawToolOptions): OpenAI.Chat.Completions.ChatCompletionTool {
  const parameters = toOpenAIToolJsonSchema(o.parameters);
  return {
    type: 'function',
    function: {
      name: o.name,
      description: o.description,
      parameters,
      strict: (o.strict ?? false) && isOpenAIStrictCompatible(parameters),
    },
  };
}

type SystemMsg = { role: 'system'; content: string };

/**
 * CHAT_TAIL_AFTER_TOOLS_V1: the system prompt as one message, or, given where its memory sits
 * (instruction-stack.ts memorySpan), as two: the prompt without the memory, then the memory. On
 * a build that renders the tools after the first system message (fireworks-wire.ts) the second
 * lands behind the tools, still in the system role, so the tools and everything a person's
 * tasks share join the cross-task prefix. Absent or malformed ⇒ the one message, byte-identical.
 */
export function splitSystem(system: string, span: MemorySpan | undefined): [SystemMsg] | [SystemMsg, SystemMsg] {
  const cut = cutMemorySpan(system, span);
  if (!cut) return [{ role: 'system', content: system }];
  return [{ role: 'system', content: cut.rest }, { role: 'system', content: cut.memory }];
}

/** The row's own `reasoning_effort` (before any side-call floor or DeepSeek's vocabulary). */
function rowReasoningEffort(caps: ReturnType<typeof resolveCapabilities>): 'low' | 'medium' | 'high' | undefined {
  return caps.thinking.mode === 'reasoning' ? clampReasoningEffort(caps.thinking.effort) : undefined;
}

/** Chat Completions `reasoning_effort` only accepts low|medium|high; clamp xhigh/max → high. */
function clampReasoningEffort(effort: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  if (effort === 'xhigh' || effort === 'max') return 'high';
  return undefined;
}

/**
 * Map a Chat Completions `finish_reason` to the stopReason vocabulary the shared
 * termination classifier understands: `length` → max_tokens (partial output),
 * `content_filter` → refusal; everything else (stop / tool_calls / null) flows
 * through as a clean completion.
 */
function mapFinishReason(finishReason: string | null): string | null {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return finishReason;
}

/**
 * Providers whose OpenAI-compatible Chat Completions endpoint accepts a
 * client-supplied `prompt_cache_key` BODY field as a cache-affinity hint WITHOUT
 * 400ing, AND for which it actually improves cache routing. Per-provider docs
 * research (2026-06-30):
 *   - openai     ✅ first-party field; never 400s; influences prefix-cache routing.
 *     ADD when they become a ModelProvider (and a seed row exists):
 *   - moonshot   ✅ documented (Kimi sometimes REQUIRES it for cache hits).
 * DEFAULT-OMIT for any provider not listed — never gamble an unknown endpoint into a 400.
 *
 * Fireworks is DELIBERATELY EXCLUDED: it does NOT honor `prompt_cache_key` (their
 * prompt-caching docs never mention the field), so #1499's body key was a no-op on this
 * lane — and an unrecognized body key is latent Fireworks strict-schema-400 risk. Fireworks'
 * cache affinity is instead sent via the `x-session-affinity` HTTP header (see callModel).
 */
const PROMPT_CACHE_KEY_PROVIDERS: ReadonlySet<ModelProvider> = new Set<ModelProvider>(['openai']);

/**
 * TOOL_SCHEMA_COMPACT_V1 — the lanes that cannot take a nullable STRING sent as a JSON Schema type
 * array (`type: ["string", "null"]`), and get zod's two-branch union back for those fields
 * (contract/tool-json-schema.ts expandNullableStringTypes). Keyed by the catalog row's `provider`
 * (the lane), never by a model name.
 *
 *   - fireworks: live on staging 2 Oct, DeepSeek V4.1 Flash wrote a stray `>` and a closing tag
 *     into an optional string (Bash `description` 2 of 3 calls, Grep `path` 1 of 2, which failed
 *     the search), never into a required string or an integer type array. The fault cannot be
 *     told apart between the model's template and the lane's tool-call parsing, so the whole lane
 *     takes the union: a model added to it later cannot silently regress. GLM, unprobed, is on it.
 *
 * Every other lane keeps the compact form (Claude, GPT and Gemini were drilled clean the same
 * day; Gemini converts it to its own nullable form). Flag off: nothing changes anywhere.
 */
const STRING_TYPE_ARRAY_UNSAFE_PROVIDERS: ReadonlySet<ModelProvider> = new Set<ModelProvider>(['fireworks']);

export interface ChatCompletionsTransportOptions {
  /** Inject a (mock) OpenAI client for tests — avoids any real API call. */
  client?: OpenAI;
  /**
   * Lazy per-provider client factory (injected by tests that assert a
   * construction throw surfaces inside callModel, and that the right base/key is
   * chosen per provider). Absent → openAIClientFor (openai-endpoints.ts) is used.
   */
  createClient?: (provider: ModelProvider, baseOverride?: string) => OpenAI;
}

/**
 * Warn-once guard: a Chat Completions provider that does not honor
 * stream_options.include_usage emits no usage chunk, so the turn would meter at
 * $0 SILENTLY (the #1 observability blind spot). Surface it once per process
 * rather than committing a silent undercharge.
 */
let warnedMissingChatUsage = false;

/**
 * The cache route a call with no `cacheKey` belongs to. Keyless calls share one
 * provider-side prefix cache, so they share one pin.
 */
const GLOBAL_CACHE_ROUTE = '__global__';

/** How many cache-route pins the prefix guard retains. See guardSystemPrefix. */
const MAX_TRACKED_CACHE_ROUTES = 256;

export class ChatCompletionsTransport implements Transport {
  readonly api = 'openai_chat_completions';
  // Nominal journal-tag label only (the Transport interface requires a static
  // provider). The Chat Completions arm has no encrypted reasoning (its
  // reasoning_content is plain text, readable by any model), so this has no
  // correctness impact; the actual client/billing route off
  // resolveCapabilities(model).provider per call (see callModel / getClient).
  readonly provider = 'openai';

  /** Injected concrete client (tests) — short-circuits the per-provider cache. */
  private readonly injectedClient: OpenAI | undefined;
  /** One lazily-built client per provider value (openai, fireworks, …). */
  private readonly clientsByProvider = new Map<ModelProvider, { client: OpenAI; credential: string | undefined; route?: string }>();   // credential = its sha256 (openAICredentialKey)
  private readonly createClient: (provider: ModelProvider, baseOverride?: string) => OpenAI;
  /** LANE_FALLBACK_V1: each provider's move to its second route, while it holds. */
  private readonly laneMoves = new Map<ModelProvider, LaneMove>();
  /** First system-prefix hash seen per cache route, for the cache-mutation guard. */
  private readonly expectedSystemHashByRoute = new Map<string, string>();

  constructor(opts: ChatCompletionsTransportOptions = {}) {
    this.injectedClient = opts.client;
    this.createClient = opts.createClient ?? openAIClientFor;
  }

  /**
   * Lazily build (and memoize, per provider and credential) the client for a provider. An injected concrete
   * client wins for every provider. A factory throw (e.g. missing key) propagates
   * to the caller so run() classifies it.
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
    return [] as Msg[];
  }

  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    // Media-refs S1: named omission notes ride the flag (transport-boundary
    // read — the pure converter itself stays env-free).
    return journalToChatCompletionsMessages(entries, noteOpts());
  }

  pushAssistant(h: ProviderHistory, blocks: ContentBlock[], replay?: ProviderReplay): void {
    const msgs = h as Msg[];
    // SEALED: the message as the provider streamed it (the `done` event's replay) —
    // raw argument strings, the provider's ids, its reasoning_content. The rebuild
    // below is the fallback for a round with no replay.
    // (Cut-off arguments are the one repair — the floor's, see withSendableToolArguments.)
    if (replay && !Array.isArray(replay) && replay.dialect === 'openai_chat_completions') {
      msgs.push(withSendableToolArguments({ ...replay.message } as Msg));
      return;
    }
    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const toolCalls = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({
        id: b.toolUseId,
        type: 'function' as const,
        function: {
          name: b.toolName,
          arguments: b.toolInput === undefined ? '{}' : JSON.stringify(b.toolInput),
        },
      }));
    const msg = withReasoning({ role: 'assistant', content: text || null }, blocks) as AssistantMsg;
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    // A message with neither content, tool_calls nor reasoning is invalid; give it a
    // placeholder. A reasoning-only round is sendable as it is (request-validity.ts).
    if (!msg.content && toolCalls.length === 0 && !('reasoning_content' in msg)) msg.content = '(no content)';
    msgs.push(msg);
  }

  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    // The `tool` role is string-only on this dialect — an image block can't ride
    // along. `toolResultText` is the SAME helper the journal converter uses (no
    // drift): ≥1 image block appends IMAGE_OMITTED_NOTE (once) after r.text so a
    // blind model KNOWS a screenshot existed; text-only results stay
    // `r.text || '(no output)'` byte-identical (an image-bearing result is never
    // empty, so the placeholder still fires only on empty text-only output).
    (h as Msg[]).push({
      role: 'tool',
      tool_call_id: r.toolUseId,
      content:
        toolResultText(r.blocks ?? [], r.text, noteOpts()) ||
        '(no output)',
    });
  }

  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], _media?: MediaBlock[]): void {
    const msgs = h as Msg[];
    if (images?.length) {
      const blocks: ContentBlock[] = [...images, ...(text ? [{ type: 'text' as const, text }] : [])];
      msgs.push({ role: 'user', content: blocksToChatContent(blocks) });
      return;
    }
    msgs.push({ role: 'user', content: text });
  }

  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    // Narration parity: same injection seam as the Anthropic arm (story spine
    // mint ladder tier-1). The dispatcher strips it before execution.
    return raw.map((o) => toChatTool(withNarrationParam(o)));
  }

  /**
   * Pin the first `system` prefix seen ON EACH CACHE ROUTE; warn LOUD (once,
   * non-fatal) on any later drift within that route. Parity with
   * AnthropicMessagesTransport.guardSystemPrefix and the Responses arm:
   * OpenAI-compatible automatic prefix caching is byte-prefix-based, so a mutated
   * system prefix silently routes to a fresh shard and reads nothing, which is
   * strictly worse than no caching. Guards `system` ONLY: within the main loop the
   * tool set is a single reused, byte-stable object (so tools never drift where the
   * guard compares), and the only places tools differ are deliberate tool-less
   * side-calls (compaction / suggestion / structured-output epilogue), which are
   * NOT drift. PURE; NEVER throws (observability only).
   *
   * KEYED BY `cacheKey` (the provider-side cache route) rather than pinned once per
   * instance. One instance serves a whole run, and those same side-calls each carry
   * their OWN system prompt, so a single slot reported every switch between lanes as
   * drift — the 2026-08-24 burn log's [CACHE_PROMPT_MUTATED] warns were all that,
   * hashes ping-ponging pairwise between two lanes. A lane can only mask real drift
   * in another lane's cache if they share a route, which is exactly when a mutated
   * prefix would actually cost a cache read.
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
        `[CACHE_PROMPT_MUTATED] openai chat-completions system prefix drifted: expected=${pinned} ` +
          `actual=${hash}. Something dynamic leaked into the cached prefix; cache reads will miss. ` +
          `Move per-turn content into the journal-projected messages (after the system prefix).`,
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
    cacheKey?: string;
    reasoningEffort?: 'low';
    systemMemorySpan?: MemorySpan;
  }): ProviderStream {
    const caps = resolveCapabilities(p.model);
    const isFireworks = caps.provider === 'fireworks';
    const systemMessages = splitSystem(p.system, isFireworks && rendersToolsAfterSystem(p.model) ? p.systemMemorySpan : undefined);
    // The route pins what its requests share: the whole system prompt, or its head when split.
    this.guardSystemPrefix(systemMessages[0].content, p.cacheKey);
    // Reasoning rides OpenAI's `reasoning_effort` for every provider on this arm
    // (clamped to low|medium|high). Fireworks (GLM + DeepSeek) accepts it.
    // DeepSeek first-party accepts low|high|max only (thinking defaults ON at
    // 'high' server-side) — 'medium' maps UP so the lane can never 400 on it.
    const rowEffort = rowReasoningEffort(caps);
    // A side call may pin the floor (the memory sweep), only where the row already sends one.
    const clampedEffort = rowEffort && p.reasoningEffort ? p.reasoningEffort : rowEffort;
    const reasoningEffort =
      caps.provider === 'deepseek' ? deepseekReasoningEffort(clampedEffort) : clampedEffort;
    // System prompt rides as the first message (Chat Completions has no separate
    // `instructions` field), its per-task tail as a second one where splitSystem says.
    // Conditional spreads keep absent knobs out of the body.
    const assembled: Msg[] = [
      ...systemMessages,
      ...(p.history as Msg[]),
    ];
    // Text-only models (Fireworks OSS lane: GLM / DeepSeek) hard-400 on an
    // image_url part, and a persisted image is replayed every turn — one image
    // would brick the session. Strip image parts from the request when the model
    // can't see them (journal ImageBlock left intact for a future vision-model
    // switch). No-op for vision-capable models (byte-identical). Media-refs S1:
    // with the lane flag on, the strip note NAMES the omitted image.
    const stripped: Msg[] =
      caps.supportsImageInput === false
        ? stripImagesFromChatMessages(assembled, noteOpts())
        : assembled;
    // Reasoning replay rides the MODEL's capability (thinking.replaysReasoning, live-
    // probed), not a provider name: a model that reads its reasoning back gets it on
    // every assistant message; any other model gets the field stripped.
    const messages: Msg[] = caps.thinking.replaysReasoning ? stripped : withoutReasoningContent(stripped);
    // Tool-schema compatibility seam (provider-gated; every other provider is
    // byte-identical):
    //   - Moonshot/Kimi: reject OpenAI-flavored param schemas (missing type,
    //     nullable anyOf, null enums) with a 400 — repair the parameters.
    //   - TOOL_SCHEMA_COMPACT_V1: a lane that mangles a nullable string sent as a type array
    //     gets zod's union back for those fields (STRING_TYPE_ARRAY_UNSAFE_PROVIDERS).
    const builtTools = p.tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    const baseTools = toolSchemaCompactEnabled() && STRING_TYPE_ARRAY_UNSAFE_PROVIDERS.has(caps.provider)
      ? builtTools.map((t) =>
          t.type === 'function' && t.function?.parameters
            ? { ...t, function: { ...t.function, parameters: expandNullableStringTypes(t.function.parameters) as OpenAI.FunctionParameters } }
            : t,
        )
      : builtTools;
    const tools = isMoonshotModel(p.model)
      ? baseTools.map((t) =>
          t.type === 'function' && t.function
            ? { ...t, function: { ...t.function, parameters: sanitizeMoonshotToolParameters(t.function.parameters) } }
            : t,
        )
      : baseTools;
    // OpenAI prompt-caching anchor (parity with the Responses arm): a stable
    // key gives automatic prefix caching deliberate cross-request shard affinity
    // (main runs: user+model-scoped via mainRunCacheKey so a NEW task's first
    // call lands on the user's already-warm shard; subagents: their own
    // per-agent-type key). PROVIDER-GATED — only sent to endpoints that model the field
    // (PROMPT_CACHE_KEY_PROVIDERS); omitted elsewhere to avoid a strict-validation
    // 400 with no upside. Fireworks is NOT in that set (it ignores this field) — its
    // affinity rides the `x-session-affinity` header on the .stream() call below instead.
    // Conditional spread ⇒ absent ⇒ no key (byte-identity).
    const promptCacheKey =
      p.cacheKey && PROMPT_CACHE_KEY_PROVIDERS.has(caps.provider) ? p.cacheKey : undefined;
    const params = {
      // Fireworks serves `accounts/fireworks/models/<slug>`; every Fireworks caller
      // rewrites the SHORT canonical id from the one table (contract/fireworks-wire.ts).
      model: isFireworks ? fireworksWireId(p.model) : p.model,
      messages,
      tools,
      max_tokens: p.maxTokens,
      // include_usage is REQUIRED to get the terminal usage chunk on this arm —
      // Fireworks included. Live-probed 2026-06-30: Fireworks ACCEPTS stream_options
      // (HTTP 200) and emits NO usage chunk WITHOUT it (so omitting it silently bills
      // $0). It behaves as a normal OpenAI-compatible endpoint here, so no special path.
      stream_options: { include_usage: true },
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    };
    const client = this.getClient(caps.provider);
    // Fireworks serverless round-robins requests across replicas, and per their docs
    // "Prompt caching only works within 1 replica"
    // (https://docs.fireworks.ai/guides/prompt-caching). Without an affinity hint, each
    // multi-round turn's growing tail lands on a different replica and re-prefills 30-70k
    // tokens (measured 37-45% hit rate). Fireworks does NOT honor #1499's `prompt_cache_key`
    // body field; it documents the `x-session-affinity` header instead. Route the SAME stable
    // user+model key (main-run-cache-key.ts) to that header so a user's requests pin to one
    // replica and the cached prefix survives. Header only — an unexpected body field risks a
    // Fireworks strict-schema 400. Non-fireworks calls keep the exact `{ signal }` options
    // object ⇒ byte-identical, no `headers` key added.
    const requestOptions =
      isFireworks && p.cacheKey
        ? { signal: p.signal, headers: { 'x-session-affinity': p.cacheKey }, ...modelResponseTimeout() }
        : { signal: p.signal, ...modelResponseTimeout() };

    // Media-refs S1 (flag-gated): vision models get https image_url parts
    // edge-inlined as data: URLs (this dialect has no file_id source, and
    // provider-side url fetch is the flaky mechanism the spec bans). The lazy
    // generator defers the fetch to the first stream read, so callModel stays
    // sync and the flag-off/no-image path returns the raw stream untouched.
    if (
      caps.supportsImageInput !== false &&
      mediaInlineChatEnabled() &&
      hasHttpsChatImages(messages)
    ) {
      return (async function* () {
        const wireMessages = await inlineChatImageParts(messages);
        yield* client.chat.completions.stream(
          { ...params, messages: wireMessages },
          requestOptions,
        ) as unknown as ChunkStream;
      })() as unknown as ChunkStream;
    }
    return client.chat.completions.stream(params, requestOptions) as unknown as ChunkStream;
  }

  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const s = stream as ChunkStream;
    const acc = createChatCompletionsAccumulator();
    let emittedText = false;
    // L1 (TOOLS_MIDSTREAM_V1): a call is ready when the next opens or the choice finishes.
    const midstream = toolsMidstreamEnabled();
    for await (const chunk of s) {
      acc.onChunk(chunk);
      const think = acc.thinkingDelta(chunk);
      if (think !== null) yield { kind: 'thinking', text: think };
      const delta = acc.textDelta(chunk);
      if (delta !== null) {
        emittedText = true;
        yield { kind: 'text', text: delta };
      }
      if (midstream) for (const toolUse of acc.takeReady()) yield { kind: 'tool_ready', toolUse };
    }
    const final = acc.final();
    if (final === null) {
      // The SSE ended with no terminal chunk — the premature-end sentinel. Under
      // NATIVE_STREAM_SEVERED_RETRY this classifies as a SEVERANCE (network_error /
      // 'stream_severed') so the engine seals the partial and re-issues the round
      // instead of burning the turn; the message lives in the ONE named constant
      // the classifier matches on.
      throw new Error(CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE);
    }
    const tools = acc.toolUses();
    // Silent-$0 guard: a non-empty turn that produced NO usage chunk would bill at
    // $0. Warn once so the undercharge is visible in logs instead of failing silently.
    if (!acc.sawUsage() && (emittedText || tools.length > 0) && !warnedMissingChatUsage) {
      warnedMissingChatUsage = true;
      console.warn(
        '[chat-completions] A non-empty turn completed with NO usage chunk ' +
          '(stream_options.include_usage not honored by this provider) — billing this turn at $0. ' +
          'Verify the provider emits a terminal usage chunk.',
      );
    }
    // PR7 — promote a SOLE refusal (no visible text, no tool calls) to content + a
    // refusal stopReason, so it routes through the shared `refused` short-circuit
    // instead of committing a silent blank turn. A refusal alongside real text or tool
    // calls is a normal, usable turn — leave it untouched (don't discard the work).
    const refusal = acc.refusal();
    const soleRefusal = !emittedText && tools.length === 0 && refusal.trim() !== '';
    if (soleRefusal) {
      yield { kind: 'text', text: refusal };
    }
    // Persist the round's FULL reasoning as a terminal thinking_block (signature
    // omitted — this dialect signs nothing): the engine leads the assistant
    // blocks with it and the journal keeps it for reload (display parity with the
    // Responses/Anthropic arms). The wire replay rides the sealed message below.
    // Reasoning-free rounds emit nothing (byte-identical non-thinking lanes).
    const reasoning = acc.reasoningText();
    if (reasoning !== '') {
      yield { kind: 'thinking_block', thinking: reasoning };
    }
    for (const tu of tools) {
      yield { kind: 'tool_use', toolUse: { id: tu.id, name: tu.name, input: tu.input } };
    }
    // SEALED: the message as streamed rides the done event (see pushAssistant).
    yield {
      kind: 'done',
      stopReason: soleRefusal ? 'refusal' : mapFinishReason(final.stopReason),
      usage: final.usage,
      replay: { dialect: 'openai_chat_completions', message: acc.message() },
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
    return classifyAnthropicTermination(a);
  }

  /** CONTEXT_APPEND_V1 (C7): the reasoning_effort a loop request sends, resolved as the request build does. */
  reasoningEffort(model: string): string | undefined {
    const caps = resolveCapabilities(model);
    const row = rowReasoningEffort(caps);
    return caps.provider === 'deepseek' ? deepseekReasoningEffort(row) : row;
  }

  defaultModel(): string {
    return 'gpt-5.4';
  }
}

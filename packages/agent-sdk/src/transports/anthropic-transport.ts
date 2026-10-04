/**
 * AnthropicMessagesTransport — the `Transport` (ModelPort) for the native
 * Anthropic Messages API arm.
 *
 * This is a THIN seam over the existing K1 native-arm code: it does NOT rewrite
 * any Anthropic logic — it DELEGATES to the already-tested converters
 * (native-messages), pricing (native-pricing), termination (native-termination)
 * and tool mapping (native-tools). The behavior-preserving refactor (K2 Task 2)
 * moves the Anthropic coupling out of `native-harness.ts` (the kernel loop) and
 * behind this class so the loop drives `Transport` and never imports an SDK.
 *
 * Provider history is `Anthropic.MessageParam[]` (the loop treats it as the
 * opaque `ProviderHistory`); the stream is the live `MessageStream` handle.
 */

import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import type { OutputFormat } from '../contract/output-format.js';
import type { CachePrefixHint } from '../contract/cache-prefix-hint.js';
import type { AnthropicReplayBlock, JournalEntry } from '../contract/journal.js';
import type { ModelUsageSummary, TurnOutcome } from '../contract/turn-outcome.js';
import type { RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';
import { toAnthropicTool } from '../engine/tool-dispatcher.js';
import { journalToAnthropicMessages, blocksToAnthropic, toolResultContent, createStreamAccumulator, replayBlocksToAnthropic } from '../engine/native-messages.js';
import {
  anthropicPricesAtFailClosed,
  chargeableAnthropicUsage,
  computeAnthropicCostUsd,
  buildModelUsage,
  denormalizeAnthropicUsage,
  normalizeAnthropicUsage,
  type AnthropicUsage,
} from '../engine/native-pricing.js';
import { classifyAnthropicError, classifyAnthropicTermination } from '../engine/native-termination.js';
import { modelResponseTimeout } from '../engine/error-authority.js';
import { resolveAnthropicThinking } from './thinking-support.js';
import {
  mediaFileIdAnthropicEnabled,
  toolDeferEnabled,
  toolsMidstreamEnabled,
} from '../policy/feature-flags.js';
import { applyToolDeferral, withToolsTailBreakpoint } from './anthropic-tool-defer.js';
import {
  materializeAnthropicFileIds,
  hasUrlImageSources,
  deferredAnthropicStream,
} from './anthropic-file-materialize.js';
import { ANTHROPIC_FILES_BETA } from './provider-file-ids.js';
import { prewarmBaseUrl, warmClientOptions } from './warm-connections.js';
import { apiPlaneRoute, LaneMove } from './lane-fallback.js';
import { resolveCapabilities, type CachePolicy } from '../contract/model-capabilities.js';
import { estimateTokens } from '../kernel/journal/token-ledger.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderReplay,
  ProviderStream,
  ProviderTool,
  StreamEvent,
  Transport,
} from '../engine/transport.js';

/**
 * Construct a real Anthropic client from the ambient credentials. Mirrors the
 * SDK's auth resolution: prefer ANTHROPIC_API_KEY, else the Railway credential
 * proxy (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL). Tests inject a mock via the
 * transport constructor so this is never reached in unit tests (no network).
 *
 * Moved here from native-harness.ts (K2 Task 2): the kernel loop must not know
 * how to build a provider client.
 */
function defaultAnthropicClient(baseOverride?: string): Anthropic {
  const { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } = process.env;
  // LANE_FALLBACK_V1: a session that moved off its lane passes the same route on the API plane.
  const baseURL = baseOverride ?? ANTHROPIC_BASE_URL;
  return new Anthropic({
    ...(ANTHROPIC_API_KEY ? { apiKey: ANTHROPIC_API_KEY } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(ANTHROPIC_AUTH_TOKEN ? { authToken: ANTHROPIC_AUTH_TOKEN } : {}),
    // One retry authority: the engine's startStreamWithRetry (round-engine.ts) — SDK retries would stack under it and run blind to our abort signal.
    maxRetries: 0,
    // WARM_CONNECTIONS_V1: the shared keep-alive pool. Off: no key at all.
    ...warmClientOptions(),
  });
}

/** The key (sha256, never the secret) of what defaultAnthropicClient authenticates with, read now. */
function anthropicCredential(): string {
  return createHash('sha256').update(`${process.env.ANTHROPIC_API_KEY ?? ''}\n${process.env.ANTHROPIC_AUTH_TOKEN ?? ''}`).digest('hex');
}

/** The MessageStream slice the loop touches: async-iterable + finalMessage(). */
type AnthropicMessageStream = AsyncIterable<Anthropic.MessageStreamEvent> & {
  finalMessage(): Promise<Anthropic.Message>;
};

/**
 * Cache placement is DATA-DRIVEN off the model-capability registry (K4C-2): the
 * lookback window and intermediate spacing come from `resolveCapabilities(model)
 * .cache` rather than module constants, so adding a provider is a policy row, not
 * a transport edit. The Anthropic seed rows carry lookbackBlocks=20 /
 * intermediateBlocks=15 (Anthropic's prompt-cache lookback walks back ~20 content
 * blocks from a `cache_control` breakpoint; a single tool-heavy turn can emit more
 * than that, pushing the next request's lookback past the prior cached point → a
 * silent full-price miss, which the ~15-block intermediate prevents). The policy
 * also seeds `minCacheableTokens`, which the token-aware placement in K4C-3
 * consumes — it is intentionally NOT read by this transport yet.
 */
const EPHEMERAL = { type: 'ephemeral' } as const;

/** The beta a per-message effort change rides (contract/per-message-effort.ts). */
export const MID_CONVERSATION_OUTPUT_CONFIG_BETA = 'mid-conversation-output-config-2026-07-01';

/**
 * A per-message effort change: an effort-only system message. It carries no text, so the
 * placement rules for mid-conversation system messages do not apply, and it takes effect from
 * the next user turn. The installed SDK types no `system` role in `messages`, hence the cast.
 */
function effortChangeMessage(effort: 'low'): Anthropic.MessageParam {
  return { role: 'system', content: [], output_config: { effort } } as unknown as Anthropic.MessageParam;
}

/** Total content-block count of one Anthropic message (a bare-string content = 1). */
function messageBlockCount(m: Anthropic.MessageParam): number {
  return Array.isArray(m.content) ? m.content.length : 1;
}

/**
 * Cheap, pure heuristic token estimate of one Anthropic message — mirrors how
 * `projectTokenCount` (token-ledger) sums a journal message: concat the text of
 * text blocks and `JSON.stringify` the input/content of tool_use/tool_result
 * blocks, then run the shared `estimateTokens`. Not a tokenizer; this only gates
 * whether a span clears `minCacheableTokens`, so a ±10% blend is fine (same
 * heuristic the compaction trigger already trusts). Never throws.
 */
function messageTokenEstimate(m: Anthropic.MessageParam): number {
  if (!Array.isArray(m.content)) return estimateTokens(m.content);
  let s = '';
  for (const b of m.content as Anthropic.ContentBlockParam[]) {
    if (b.type === 'text') {
      s += b.text + ' ';
    } else if (b.type === 'tool_use') {
      s += JSON.stringify(b.input ?? {}) + ' ';
    } else if (b.type === 'tool_result') {
      // content is string | ContentBlockParam[] | undefined — stringify either shape.
      s += (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')) + ' ';
    } else {
      s += JSON.stringify(b) + ' ';
    }
  }
  return estimateTokens(s);
}

/** Sum the heuristic token estimate of `history[from..to]` inclusive. Pure, never throws. */
function spanTokenEstimate(history: Anthropic.MessageParam[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i <= to && i < history.length; i++) n += messageTokenEstimate(history[i]);
  return n;
}

/** Clone a message attaching cache_control to its LAST content block (a bare-string content is wrapped). */
function withTailBreakpoint(m: Anthropic.MessageParam): Anthropic.MessageParam {
  if (!Array.isArray(m.content)) {
    // A bare EMPTY string can't carry a breakpoint — wrapping it as a text block
    // would make Anthropic 400 on `cache_control` set for an empty text block — so
    // leave the message untouched (no breakpoint on a degenerate turn).
    if (!m.content) return m;
    return { ...m, content: [{ type: 'text', text: m.content, cache_control: EPHEMERAL }] };
  }
  const content = m.content.slice();
  const last = content[content.length - 1];
  content[content.length - 1] = { ...(last as object), cache_control: EPHEMERAL } as typeof last;
  return { ...m, content };
}

/**
 * Pure: return a cache-annotated CLONE of `history` (the caller's array/objects
 * are never mutated). Attaches:
 *   - the ROLLING breakpoint on the last content block of the LAST message
 *     (the incremental multi-turn win — earlier breakpoints stay valid read
 *     points so cache hits accrue as the conversation grows; ALWAYS placed, it
 *     is the incremental-growth anchor and costs nothing extra), and
 *   - ONE secondary breakpoint chosen ADAPTIVELY (K4C-3):
 *       • COMPACTION-AWARE (when `hint.summaryLeading`): anchor the stable
 *         post-compaction prefix — the FIRST message at which the CUMULATIVE
 *         cacheable prefix (base + messages[0..i]) clears `minCacheableTokens`
 *         (so the anchored prefix is worth caching). The summary head sits at a
 *         FIXED front position until the next compaction, so it re-caches once and
 *         reuses while the rolling breakpoint's ≤lookback window can't reach it
 *         once the history regrows. The anchor REUSES the intermediate slot.
 *       • TAIL-INTERMEDIATE (otherwise): when the trailing turn spans more than
 *         the policy's lookback window AND the CUMULATIVE prefix it would cache
 *         clears `minCacheableTokens`, place an intermediate
 *         ~`policy.intermediateBlocks` blocks back from the tail so the next
 *         request's lookback still reaches a cached point. A sub-floor prefix is
 *         SKIPPED (token-aware) — the slot would cache nothing readable.
 *
 * CUMULATIVE FLOOR BASIS (the K4C-3 review fix): Anthropic's ~1024/2048 minimum
 * applies to the WHOLE cacheable prefix BEFORE a breakpoint, rendered
 * `tools → system → messages[0..bp]` — NOT the message span alone. `basePrefixTokens`
 * (= estimated system + tools, supplied by the caller, who has them in scope) is
 * therefore ADDED to the message-span estimate before comparing to the floor. Since
 * system + tools are always large for the real native arm, the gate almost never
 * skips a message breakpoint — it is a DEFENSIVE guard for the degenerate
 * (tiny-or-empty system + no tools) case, not a routine pruner. Default 0 keeps it
 * conservative when a caller omits the base.
 *
 * The lookback/intermediate windows + the `minCacheableTokens` floor are sourced
 * from the model-capability cache policy (K4C-2/3). For a normal (no-hint)
 * history whose cumulative prefix clears the floor, this is byte-identical to K4C-2.
 *
 * BUDGET ARITHMETIC: AT MOST ONE secondary breakpoint (anchor OR intermediate,
 * never both) is ever placed, so the TOTAL always stays within
 * `policy.breakpointBudget` (Anthropic 4): [1] system + [2] tools tail (when
 * present) + [3] rolling + [+1] at most one secondary = ≤ 4. Empty/short/
 * sub-floor history → just the rolling breakpoint.
 */
function applyMessageCacheBreakpoints(
  history: Anthropic.MessageParam[],
  policy: CachePolicy,
  hint?: CachePrefixHint,
  basePrefixTokens = 0,
  // CACHE_TIERING_V1: message-side breakpoint allowance left after the prefix
  // (system block(s) + tools tail) spent theirs. 2 = rolling + one secondary
  // (the pre-tiering behavior, and the cap either way); 1 = rolling only —
  // the price of the fleet/session system split, paid here so the request
  // never exceeds `policy.breakpointBudget`.
  maxMessageBreakpoints = 2,
): Anthropic.MessageParam[] {
  if (history.length === 0) return history;
  const out = history.slice();
  const lastIdx = out.length - 1;
  const floor = policy.minCacheableTokens;
  const allowSecondary = maxMessageBreakpoints >= 2;

  // Pick the single secondary breakpoint position (off the ORIGINAL counts so the
  // rolling clone of the tail message doesn't perturb the accounting). -1 = none.
  let secondaryIdx = -1;

  if (!allowSecondary) {
    // budget spent on the system split — rolling only
  } else if (hint?.summaryLeading) {
    // COMPACTION-AWARE: anchor the stable prefix. Walk FORWARD from the start to
    // the first message at which the CUMULATIVE prefix (base + messages[0..i])
    // clears the floor — the smallest worth-caching prefix anchored on the summary
    // head. If even the whole prefix is sub-floor there is nothing worth anchoring
    // (skip). The anchor reuses the intermediate slot, so the tail-intermediate is
    // NOT placed.
    let acc = basePrefixTokens;
    for (let i = 0; i <= lastIdx; i++) {
      acc += messageTokenEstimate(out[i]);
      if (acc >= floor) {
        secondaryIdx = i;
        break;
      }
    }
    // Never collapse onto the rolling rider's own message (it already gets a bp).
    if (secondaryIdx === lastIdx) secondaryIdx = -1;
  } else {
    // TAIL-INTERMEDIATE: only when the trailing block span exceeds the lookback.
    let trailingBlocks = 0;
    for (let i = lastIdx; i >= 0; i--) trailingBlocks += messageBlockCount(out[i]);
    if (trailingBlocks > policy.lookbackBlocks) {
      // Walk back from the tail; the intermediate rides the message at which the
      // cumulative block count first reaches the policy intermediate spacing
      // (window-to-tail ≈ intermediateBlocks ≤ lookbackBlocks).
      let acc = 0;
      let candidate = -1;
      for (let i = lastIdx; i >= 0; i--) {
        acc += messageBlockCount(out[i]);
        if (acc >= policy.intermediateBlocks) {
          candidate = i;
          break;
        }
      }
      // Never collapse onto the rolling rider's own message.
      if (candidate !== lastIdx && candidate >= 0) {
        // TOKEN-AWARE (K4C-3 D1): the intermediate caches the CUMULATIVE prefix
        // rendered before it — base (tools+system) + the message span from the
        // START up to (and including) the candidate. The next request's lookback
        // reads back from the tail to this cached point. Only place it when that
        // cumulative prefix clears the floor; a sub-floor breakpoint caches nothing
        // readable and wastes the slot. (Since base is large for the real arm, this
        // gate effectively only skips the degenerate tiny-system/no-tools case.)
        if (basePrefixTokens + spanTokenEstimate(out, 0, candidate) >= floor) {
          secondaryIdx = candidate;
        }
      }
    }
  }

  if (secondaryIdx >= 0) out[secondaryIdx] = withTailBreakpoint(out[secondaryIdx]);
  out[lastIdx] = withTailBreakpoint(out[lastIdx]);
  return out;
}

/**
 * The provider's final message → the verbatim-replay channel, in emission order.
 *
 * Known types map to their typed variants so the existing replay path is
 * unchanged; everything else rides as `provider_raw` and is handed back byte-for-
 * byte. Returns undefined when the client gave us no content array (an older SDK,
 * or a test double), so the caller falls back to the accumulator rather than
 * replaying an empty turn.
 *
 * Unsigned thinking is dropped here for the same reason `pushAssistant` drops it:
 * the API rejects unsigned thinking on replay.
 */
function replayBlocksFromFinalMessage(final: unknown): AnthropicReplayBlock[] | undefined {
  const content = (final as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const out: AnthropicReplayBlock[] = [];
  for (const raw of content) {
    const b = raw as { type?: string; [k: string]: unknown };
    if (b.type === 'text') {
      out.push({ type: 'text', text: String(b.text ?? '') });
    } else if (b.type === 'thinking') {
      const signature = typeof b.signature === 'string' ? b.signature : '';
      if (signature) out.push({ type: 'thinking', thinking: String(b.thinking ?? ''), signature });
    } else if (b.type === 'redacted_thinking') {
      out.push({ type: 'redacted_thinking', data: String(b.data ?? '') });
    } else if (b.type === 'tool_use') {
      out.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input });
    } else {
      out.push({ type: 'provider_raw', raw });
    }
  }
  return out;
}

/**
 * A server-side tool search that came back with nothing the model can use.
 *
 * Both outcomes here are 200s. The API ran the search, the search produced no
 * tools, and the turn continues exactly as if the model had never asked — so the
 * model quietly proceeds without a capability it went looking for, and no error
 * reaches anyone. That is the same shape as every deferral bug we have shipped:
 * not a failure, a number that stops moving.
 *
 *   TOOL_SEARCH_FAILED — `tool_search_tool_result_error`. The search could not
 *     run: a malformed or over-long pattern (`invalid_tool_input`), a timeout or
 *     outage (`unavailable`), throttling (`too_many_requests`), or
 *     `execution_time_exceeded`. Nothing about this is the model's fault and
 *     nothing retries it.
 *   TOOL_SEARCH_EMPTY — the search ran and matched zero tools. Logging the
 *     PATTERN is the point: Anthropic's own debugging advice is to check the
 *     pattern against the names, which is impossible after the fact unless the
 *     pattern was written down. A recurring miss means an index name and the way
 *     the model describes that capability have drifted apart.
 *
 * Parsed structurally, never by matching text: `error_code` and `tool_references`
 * are fields, and a shape we do not recognise is passed over rather than guessed.
 */
function reportBarrenToolSearch(final: unknown): void {
  const content = (final as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return;

  // srvtoolu id → the pattern (regex variant) or query (BM25) that was run.
  const queries = new Map<string, string>();
  for (const raw of content) {
    const b = raw as { type?: string; id?: unknown; input?: { pattern?: unknown; query?: unknown } };
    if (b.type !== 'server_tool_use' || typeof b.id !== 'string') continue;
    const q = b.input?.pattern ?? b.input?.query;
    queries.set(b.id, typeof q === 'string' ? q : '(unreadable)');
  }

  for (const raw of content) {
    const b = raw as {
      type?: string;
      tool_use_id?: unknown;
      content?: { type?: string; error_code?: unknown; error_message?: unknown; tool_references?: unknown };
    };
    if (b.type !== 'tool_search_tool_result') continue;
    const query = queries.get(typeof b.tool_use_id === 'string' ? b.tool_use_id : '') ?? '(unknown)';
    const inner = b.content;

    if (inner?.type === 'tool_search_tool_result_error') {
      console.warn(
        `[TOOL_SEARCH_FAILED] the provider could not run a tool search: code=${String(inner.error_code)} ` +
          `query=${JSON.stringify(query)} message=${String(inner.error_message)}. The model asked for a ` +
          `capability and silently got none — it will carry on without it.`,
      );
      continue;
    }
    if (Array.isArray(inner?.tool_references) && inner.tool_references.length === 0) {
      console.warn(
        `[TOOL_SEARCH_EMPTY] a tool search matched nothing: query=${JSON.stringify(query)}. Either the ` +
          `capability is genuinely absent, or the deferred tool's name and description do not carry the ` +
          `words the model reaches for.`,
      );
    }
  }
}

export interface AnthropicTransportOptions {
  /** Inject a (mock) Anthropic client for tests — avoids any real API call. */
  client?: Anthropic;
  /**
   * Lazy client factory (injected by tests that assert a construction throw
   * surfaces inside run()). Absent → defaultAnthropicClient is used.
   */
  createClient?: (baseOverride?: string) => Anthropic;
}

export class AnthropicMessagesTransport implements Transport {
  readonly api = 'anthropic_messages';
  readonly provider = 'anthropic';

  /** Resolved on first model call (lazy so a construction throw surfaces in run()). */
  private client: Anthropic | undefined;
  private readonly createClient: (baseOverride?: string) => Anthropic;
  /** LANE_FALLBACK_V1: this transport's move to its second route, while it holds. */
  private readonly laneMove = new LaneMove();
  /** The route the built client rides (undefined: the lane). */
  private clientRoute: string | undefined;
  /** An injected concrete client (tests) is never rebuilt. */
  private readonly injectedClient: boolean;
  /** The key (sha256) of the credential the built client carries (anthropicCredential at build time). */
  private clientCredential: string | undefined;

  /**
   * Native prefix-hash guard (K4-T8). The first `system` prefix this transport
   * INSTANCE sees is pinned; later drift warns `[CACHE_PROMPT_MUTATED]` once.
   * Instance-scoped (NOT a module-load constant like the executor's, because the
   * native system prompt is per-session) — so cold restarts re-pin cleanly.
   */
  private expectedSystemHash: string | undefined;

  /**
   * The verbatim-replay channel stashed off the LAST readStream, exposed via
   * `capturedOrderedBlocks()` (mirrors the OpenAI arm's `capturedReasoning` stash).
   * Set on every round that returned content; cleared at the start of each stream.
   */
  private lastOrderedBlocks: AnthropicReplayBlock[] | undefined;

  constructor(opts: AnthropicTransportOptions = {}) {
    this.client = opts.client;
    this.injectedClient = opts.client !== undefined;
    this.createClient = opts.createClient ?? defaultAnthropicClient;
  }

  /**
   * Lazily build the client, and build it again when the credential changed. A run stays warm
   * across turns (and across a box's freeze), and the runner's token refresh swaps process.env,
   * never a client already built: one built from the old token 401s every turn once it expires
   * (staging 2026-10-02, task 1106ef29). A factory throw propagates to the caller.
   */
  private getClient(): Anthropic {
    const credential = anthropicCredential();
    const route = this.laneMove.current();
    if (!this.client || (!this.injectedClient && (credential !== this.clientCredential || route !== this.clientRoute))) {
      this.client = route === undefined ? this.createClient() : this.createClient(route);
      this.clientCredential = credential;
      this.clientRoute = route;
    }
    return this.client;
  }

  /** LANE_FALLBACK_V1: move to the same proxy route on the API plane while the move holds. */
  fallBackLane(_model?: string, until?: number): boolean {
    if (this.injectedClient) return false;
    return this.laneMove.move(apiPlaneRoute('anthropic', process.env.ANTHROPIC_BASE_URL), until);
  }

  /** WARM_CONNECTIONS_V1: open the connection this client's next request will ride. */
  prewarm(): void {
    prewarmBaseUrl(() => this.getClient().baseURL);
  }

  emptyHistory(): ProviderHistory {
    return [] as Anthropic.MessageParam[];
  }

  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return journalToAnthropicMessages(entries);
  }

  pushAssistant(h: ProviderHistory, blocks: ContentBlock[], replay?: ProviderReplay): void {
    // The provider's own message, when the caller carried it from the `done` event:
    // sent back exactly as it came (the rebuild below drops server blocks and can
    // reorder nothing correctly that it does not model). Anthropic's replay is the
    // bare block array; another dialect's never reaches here.
    if (Array.isArray(replay) && replay.length > 0) {
      (h as Anthropic.MessageParam[]).push({ role: 'assistant', content: replayBlocksToAnthropic(replay) });
      return;
    }
    // signed thinking + text + any tool_use blocks → one assistant message (the
    // in-memory push previously inline in iterateTurn). Block order is preserved,
    // so a thinking block leading the array stays first (the API requires thinking
    // before tool_use when interleaved thinking is on). A SIGNED thinking block is
    // replayed verbatim (thinking + signature); an unsigned one is dropped (the API
    // rejects unsigned thinking replay). tool_use arrives as the neutral
    // ContentBlock `ToolUseBlock` shape (toolUseId / toolName / toolInput).
    const content: Anthropic.ContentBlockParam[] = [];
    for (const b of blocks) {
      if (b.type === 'text') {
        content.push({ type: 'text', text: b.text });
      } else if (b.type === 'thinking' && b.signature) {
        content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
      } else if (b.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: b.toolUseId,
          name: b.toolName,
          input: (b.toolInput ?? {}) as Record<string, unknown>,
        });
      }
    }
    if (content.length) {
      (h as Anthropic.MessageParam[]).push({ role: 'assistant', content });
    }
  }

  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    // When the dispatch result carries image blocks (browser-control screenshots),
    // emit the ARRAY content form (text param(s) + image param(s)); otherwise keep
    // `content: r.text` as a bare string (byte-identical). `toolResultContent` is the
    // SAME helper the journal converter uses, so the two paths can't drift — and the
    // text-only fallback stays `r.text` exactly (this path's existing text source).
    (h as Anthropic.MessageParam[]).push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: r.toolUseId,
          content: toolResultContent(r.blocks ?? [], r.text),
          is_error: r.isError,
        },
      ],
    });
  }

  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], _media?: MediaBlock[]): void {
    if (images?.length) {
      // Image content blocks lead (image-before-text), then the text when non-empty.
      // Reuses blocksToAnthropic so the image-block → param mapping has ONE source of
      // truth (shared with the journal projection).
      const content: Anthropic.ContentBlockParam[] = [
        ...blocksToAnthropic(images),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ];
      (h as Anthropic.MessageParam[]).push({ role: 'user', content });
      return;
    }
    (h as Anthropic.MessageParam[]).push({ role: 'user', content: text });
  }

  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    // WebSearch is now OUR OWN fn tool (Parallel-backed, in the RawToolOptions
    // list) — NOT an Anthropic-hosted provider tool. So this is a straight map;
    // no provider tool is appended. The last fn tool remains session-stable, so
    // it stays a valid carrier for the cache_control breakpoint callModel adds.
    //
    // The narration injector already converted every tool's `parameters` to plain
    // JSON Schema and dropped `$schema` (tool-dispatcher.withNarrationParam), so
    // real schema + every `.describe()` doc is simply what this lane ships —
    // TOOL_SCHEMA_JSON_V1 graduated and there is no mapper left to thread.
    //
    // TOOL_DEFER_V1 OFF (default): `defer` is false for every tool → no
    // `defer_loading` key is emitted at all, byte-identical to today. ON: only
    // tools that opted in via `deferrable` carry the flag. This is a PROPOSAL —
    // buildTools runs once and knows no model, so callModel re-decides per request
    // against the model's actual capability (see applyToolDeferral). Read per call,
    // not cached on the instance, so a long-lived transport can't pin a stale value.
    const defer = toolDeferEnabled();
    return raw.map((o) => toAnthropicTool(o, defer && o.deferrable === true));
  }

  /**
   * Pin the first `system` prefix seen by this instance; warn LOUD (once,
   * non-fatal) on any later drift. Anthropic prompt caching is prefix-based: a
   * byte-changed system prefix silently writes a fresh cache entry and reads
   * nothing — strictly worse than no caching. NEVER throws (pure observation).
   */
  private guardSystemPrefix(system: string): void {
    const hash = createHash('sha256').update(system).digest('hex').slice(0, 12);
    if (this.expectedSystemHash === undefined) {
      this.expectedSystemHash = hash; // pin on the first turn
      return;
    }
    if (hash !== this.expectedSystemHash) {
      console.warn(
        `[CACHE_PROMPT_MUTATED] native system prefix drifted: expected=${this.expectedSystemHash} ` +
          `actual=${hash}. Something dynamic leaked into the cached prefix — cache reads will miss. ` +
          `Move per-turn content into the journal-projected messages (after the system breakpoint).`,
      );
      // Re-pin so we warn ONCE per drift, not on every subsequent turn.
      this.expectedSystemHash = hash;
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
    cachePrefixHint?: CachePrefixHint;
    systemFleetPrefixChars?: number;
    /** COMPACTION_V2 — suppress every cache WRITE on this one-shot. See the guard below. */
    noCacheWrite?: boolean;
    reasoningEffort?: 'low';
    turnEffort?: 'low';
  }): ProviderStream {
    this.guardSystemPrefix(p.system);

    // Stage B (K4-T8): cache_control on the LAST tool schema. Tools are
    // session-stable (the InstructionStack assembler + frozen Nami block, K4
    // T4/T6, freeze the tool set per session) → a one-write-per-session cache
    // segment, rendered AFTER the system prefix (tools→system→messages order).
    // Pure clone — the caller's tools array/objects are never mutated.
    //
    // TOOL_DEFER_V1: shape the catalog BEFORE placing the breakpoint. Deferral can
    // add the search tool and can hand back an undeferred copy (ineligible model /
    // all-deferred fallback), and a `defer_loading` tool may not also carry
    // `cache_control` — so the anchor has to be chosen against the FINAL array.
    // With the flag off both calls are pass-throughs and the marker lands on the
    // last tool exactly as before.
    //
    // THESE TWO STEPS ARE DELIBERATELY SEPARATE STATEMENTS, and a caller that wants
    // to suppress the cache WRITE must skip only the second. They answer different
    // questions:
    //   applyToolDeferral      — WHICH tools are resident. A property of the request.
    //   withToolsTailBreakpoint — whether this request WRITES a cache entry.
    // Wrapping both in one "skip caching" branch would quietly un-defer the catalog
    // and put the whole browser ring back into that call's context — the opposite of
    // what any caller asking not to cache is trying to achieve. Deferral always runs.
    // COMPACTION_V2 (coordinator-approved fence crossing): `noCacheWrite` is the
    // caller saying "this request is a ONE-SHOT whose prefix can never be read
    // again — do not spend a cache write on it". Today only the compaction
    // summarize sets it: it renders a span the compaction is about to delete, so
    // the write pays the 1.25x premium on bytes nobody will ever read AND competes
    // with the LIVE task prefix for residency, which can evict the prefix every
    // real round depends on. Absent (every other call) ⇒ byte-identical placement.
    //
    // It suppresses the three cache WRITES below (tools tail, system tail, message
    // rolling/secondary) and NOTHING ELSE. Per the invariant named above,
    // applyToolDeferral is deliberately OUTSIDE this branch — it decides WHICH
    // tools are resident, not whether we cache, and skipping it would put the whole
    // deferred catalog back into the context of the very call trying to stay small.
    const noCacheWrite = p.noCacheWrite === true;
    const rawTools = p.tools as Anthropic.ToolUnion[];
    const shapedTools = rawTools.length ? applyToolDeferral(rawTools, p.model) : rawTools;
    const tools =
      shapedTools.length && !noCacheWrite ? withToolsTailBreakpoint(shapedTools, EPHEMERAL) : shapedTools;
    // Rolling conversation breakpoint + (when the trailing turn is long) ONE
    // intermediate ~policy.intermediateBlocks back — pure array work over a CLONE
    // (the loop's history is never mutated). Empty/short history → just the rolling
    // breakpoint. The 4-breakpoint budget always holds: [1] system + [2] tools tail
    // (when present) + [3] rolling + [+1] AT MOST ONE intermediate = ≤ 4.
    //
    // The lookback/intermediate windows are DATA-DRIVEN off the model-capability
    // cache policy (K4C-2): the Anthropic seed carries 20/15 → byte-identical to
    // the prior hardcoded behavior. (minCacheableTokens is also seeded on the
    // policy but consumed by K4C-3's token-aware placement, not this transport.)
    const cachePolicy = resolveCapabilities(p.model).cache;
    // CACHE_TIERING_V1: split the system into [fleet | session] blocks at the
    // caller-supplied boundary IFF the boundary is in-range and the fleet prefix
    // clears the model's cacheable floor (a sub-floor block would spend a
    // breakpoint caching nothing readable). The CONCATENATED bytes equal
    // `p.system` by construction — guardSystemPrefix above still sees the one
    // true string — so tiering can only change breakpoint placement, never what
    // the model reads. No hint (every caller today except the flag-on main run)
    // ⇒ `tierSystem === false` ⇒ the request is byte-identical.
    const fleetChars = p.systemFleetPrefixChars ?? 0;
    const tierSystem =
      fleetChars > 0 &&
      fleetChars < p.system.length &&
      estimateTokens(p.system.slice(0, fleetChars)) >= cachePolicy.minCacheableTokens;
    // K4C-3 D1: the token-aware floor applies to the CUMULATIVE cacheable prefix at
    // a message breakpoint, which is rendered `tools → system → messages[0..bp]`.
    // system + tools are ALWAYS the front of that prefix, so the gate must add their
    // token weight (not measure messages-only). Estimate them ONCE here (they're in
    // scope) and thread the base into the placement so it never re-derives them.
    const basePrefixTokens =
      estimateTokens(p.system) + estimateTokens(JSON.stringify(p.tools ?? []));
    // Message-side budget = whatever the prefix blocks left unspent. Untiered:
    // system(1) + tools(1) → 2 left (rolling + one secondary — the pre-tiering
    // arithmetic, unchanged). Tiered: system(2) + tools(1) → 1 left (rolling
    // only). The placement fn caps at 2 regardless, so a no-system/no-tools
    // degenerate call stays at today's rolling+secondary.
    const prefixBreakpoints = (p.system ? (tierSystem ? 2 : 1) : 0) + (p.tools?.length ? 1 : 0);
    // noCacheWrite: skip the rolling + secondary message breakpoints. This is the
    // expensive one for the summarize call — the rolling breakpoint sits on the LAST
    // message, so it caches the ENTIRE dropped span rendered before it.
    const messages = noCacheWrite
      ? (p.history as Anthropic.MessageParam[])
      : applyMessageCacheBreakpoints(
          p.history as Anthropic.MessageParam[],
          cachePolicy,
          p.cachePrefixHint,
          basePrefixTokens,
          cachePolicy.breakpointBudget - prefixBreakpoints,
        );

    // Extended thinking / effort — fully registry-driven per model (see
    // thinking-support). Each Anthropic thinking `mode` carries a DISTINCT request
    // shape: 'enabled' → thinking:{type:'enabled', budget_tokens} + interleaved
    // beta (+ output_config.effort iff supported); 'adaptive' →
    // thinking:{type:'adaptive'} + output_config.effort, NO beta; 'always_on' → NO
    // thinking field (always on; {disabled} is rejected) + output_config.effort.
    // 'none'/unknown → null → no thinking/effort sent (no break, no 400). The
    // accumulator/converter handle signed thinking identically for enabled AND
    // adaptive, so multi-turn signature replay is unchanged. cache_control stays on
    // system/tools/message tails (NOT on any thinking block), so it coexists.
    const resolvedThinking = resolveAnthropicThinking(p.model, p.maxTokens);
    // A side call may pin the floor (the memory sweep), only on a model that takes an effort
    // at all: a row without one (Haiku 4.5 / Sonnet 4.5) keeps its request unchanged.
    const cfg =
      resolvedThinking?.outputConfig && p.reasoningEffort
        ? { ...resolvedThinking, outputConfig: { effort: p.reasoningEffort } }
        : resolvedThinking;

    // P6 E2: terminal constrained call. When the engine hands us an outputFormat,
    // MERGE a json_schema `format` into the SAME output_config that already carries
    // `effort` (from cfg.outputConfig) — never clobber effort, and never materialize
    // an output_config when neither effort nor format is present (absent-case stays
    // byte-identical). The installed SDK's JSONOutputFormat type predates `name`, so
    // the format object is cast through `unknown` (the wire API accepts `name`).
    const outputConfig = (() => {
      if (!p.outputFormat) return cfg?.outputConfig;
      const format = {
        type: 'json_schema',
        name: p.outputFormat.name,
        schema: p.outputFormat.schema,
      } as unknown as NonNullable<Anthropic.Messages.OutputConfig['format']>;
      return { ...(cfg?.outputConfig ?? {}), format } as Anthropic.Messages.OutputConfig;
    })();

    // SWEEP_EFFORT_MESSAGE_V1: `turnEffort` rides as a per-message effort change just before the
    // last message, so the request keeps the loop's top-level effort (part of the cache key) while
    // its last turn reasons at the floor. Only on a row that takes one, with thinking on
    // (contract/per-message-effort.ts); anywhere else nothing is added. It goes in after the
    // breakpoints are placed, so they sit where they would without it, and it carries none.
    const effortChange =
      p.turnEffort && cfg?.thinking && resolveCapabilities(p.model).thinking.perMessageEffort && messages.length > 0
        ? p.turnEffort
        : undefined;
    const wire = effortChange
      ? [...messages.slice(0, -1), effortChangeMessage(effortChange), messages[messages.length - 1]!]
      : messages;

    const startStream = (
      wireMessages: Anthropic.MessageParam[],
      filesBeta: boolean,
    ): ReturnType<Anthropic['messages']['stream']> => {
      // Interleaved-thinking beta + (S1) files beta + the per-message effort beta, comma-joined.
      const beta = [cfg?.beta, filesBeta ? ANTHROPIC_FILES_BETA : undefined, effortChange ? MID_CONVERSATION_OUTPUT_CONFIG_BETA : undefined]
        .filter((b): b is string => Boolean(b))
        .join(',');
      return this.getClient().messages.stream(
      {
        model: p.model,
        max_tokens: p.maxTokens,
        // thinking is present for 'enabled'/'adaptive' and absent for 'always_on'.
        ...(cfg?.thinking ? { thinking: cfg.thinking } : {}),
        // output_config carries effort (when supported) AND/OR the P6 json_schema
        // format (terminal constrained call). Omitted entirely when neither applies.
        ...(outputConfig ? { output_config: outputConfig } : {}),
        // Stage A (K4-T8): cache_control on the LAST system block — the whole
        // assembled InstructionStack (static layers + the session-frozen tail:
        // agent_mode/situation/nami) is session-stable, so one breakpoint at its
        // end caches tools+system together (render order tools→system→messages).
        // CACHE_TIERING_V1: when the caller marked the fleet-prefix boundary
        // (`tierSystem`), the SAME bytes ship as TWO text blocks split at that
        // boundary, each carrying a breakpoint: the fleet block's bytes are
        // identical across every user/task of a deploy (org-scoped cache ⇒ the
        // whole fleet keeps it warm), while the per-user/session remainder varies
        // behind it without busting it. Concatenation is byte-equal to `p.system`.
        // OMIT `system` entirely when it's empty (e.g. a general-purpose subagent
        // with no systemPrompt): Anthropic 400s on `cache_control` set for an empty
        // text block, and an absent system is legal (parity with the gemini arm's
        // `p.system ?` guard). Non-empty → the block bytes stay identical.
        // noCacheWrite: the same bytes ship WITHOUT the breakpoint — the block is
        // unchanged, only the cache_control marker is dropped.
        ...(p.system
          ? {
              system: (noCacheWrite
                ? [{ type: 'text', text: p.system }]
                : tierSystem
                ? [
                    { type: 'text', text: p.system.slice(0, fleetChars), cache_control: EPHEMERAL },
                    { type: 'text', text: p.system.slice(fleetChars), cache_control: EPHEMERAL },
                  ]
                : [
                    { type: 'text', text: p.system, cache_control: EPHEMERAL },
                  ]) as Anthropic.TextBlockParam[],
            }
          : {}),
        tools,
        messages: wireMessages,
      },
      {
        signal: p.signal,
        // Per-request beta header (interleaved thinking and/or files, see above).
        ...(beta ? { headers: { 'anthropic-beta': beta } } : {}),
        // NETWORK_WAIT_V1: a proxy that never answers fails in minutes, not the SDK's ten.
        ...modelResponseTimeout(),
      },
      );
    };

    // Media-refs S1 (flag-gated): url image sources → Files API file_id on a
    // wire copy; canonical history keeps the url form. The lazy facade defers
    // the async upload to the first stream read, so callModel stays sync and
    // the flag-off/no-image path returns the raw stream byte-identically.
    if (mediaFileIdAnthropicEnabled() && hasUrlImageSources(wire)) {
      return deferredAnthropicStream(async () => {
        const m = await materializeAnthropicFileIds(wire, this.getClient());
        return startStream(m.messages, m.usedFileIds);
      });
    }
    return startStream(wire, false);
  }

  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const s = stream as AnthropicMessageStream;
    const acc = createStreamAccumulator();
    // A stream that dies before finalMessage() must not leave the PREVIOUS round's
    // channel stashed — the loop would journal it onto this round's entry.
    this.lastOrderedBlocks = undefined;
    // L1 (TOOLS_MIDSTREAM_V1): a call is ready at its content_block_stop. Off: no event.
    const midstream = toolsMidstreamEnabled();

    // Live pass: feed every event to the accumulator, surfacing text + thinking
    // deltas as they stream (parity with the K1 loop's AGENT_TEXT_DELTA /
    // AGENT_THINKING_DELTA emission points). thinkingDelta is null for non-thinking
    // events, so the order is preserved (a thinking phase streams, then text).
    for await (const ev of s) {
      acc.onEvent(ev);
      // Signal the OPEN of a thinking block BEFORE its text streams, so the UI can
      // mount the thinking pill (+ running timer) immediately — Anthropic's
      // summarized adaptive thinking lags the block start by seconds.
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
        yield { kind: 'thinking_start' };
      }
      const think = acc.thinkingDelta(ev);
      if (think) yield { kind: 'thinking', text: think };
      const delta = acc.textDelta(ev);
      if (delta) yield { kind: 'text', text: delta };
      if (midstream) for (const toolUse of acc.takeReady()) yield { kind: 'tool_ready', toolUse };
    }

    // The full turn is now accumulated.
    // Emit each COMPLETED thinking block (with signature) BEFORE the tool_uses so
    // the loop journals thinking ahead of the assistant text/tool_use — the order
    // the model produced them, and the order the next request must replay them in
    // (multi-turn extended-thinking correctness). blocks() yields text + thinking
    // in emission order; we forward only the thinking blocks here (the text is
    // already accumulated by the loop from the live `text` deltas above).
    for (const b of acc.blocks()) {
      if (b.type === 'thinking') {
        yield {
          kind: 'thinking_block',
          thinking: b.thinking,
          // Under the SDK's exactOptionalPropertyTypes, omit the optional key when
          // there's no signature (rather than setting it to `undefined`) — the same
          // value every consumer sees, since StreamEvent declares `signature?: string`.
          ...(b.signature !== undefined ? { signature: b.signature } : {}),
        };
      }
    }

    // Emit each captured tool_use, then `done`.
    for (const tu of acc.toolUses()) {
      yield { kind: 'tool_use', toolUse: { id: tu.id, name: tu.name, input: tu.input } };
    }

    const final = await s.finalMessage();

    // A deferred tool the model searched for and did not get is invisible in every
    // other signal: the turn succeeds, the tool is simply never called.
    reportBarrenToolSearch(final);

    /*
     * Stash the verbatim-replay channel for the loop to ride onto the assistant
     * journal entry (read via capturedOrderedBlocks, mirroring capturedReasoning).
     *
     * Sourced from the SDK's OWN assembled message, not from our hand-rolled
     * accumulation. `final.content` carries every block the provider sent,
     * including the types this SDK does not model; the accumulator carries only
     * the four it does, and silently bins the rest. Reconstructing what the
     * provider already hands us whole is what lost the `server_tool_use` pair on
     * 09-16 and wedged a task permanently. The accumulator remains the fallback
     * for a client (or a test double) that returns no final content.
     *
     * UNGATED, every round. The provider's message is signed as a whole, so the
     * only replay that is always legal is the one that sends it back as it came.
     * The old gate tried to predict which shapes the split projection could
     * rebuild; every shape it failed to predict was a permanent wedge (09-16:
     * dropped server blocks; 09-22: a tool-search result LEADING a continuation,
     * hoisted behind the thinking it preceded). No prediction, no gap.
     */
    const ordered = replayBlocksFromFinalMessage(final) ?? acc.orderedBlocks();
    this.lastOrderedBlocks = ordered.length > 0 ? ordered : undefined;

    yield {
      kind: 'done',
      stopReason: final.stop_reason,
      // Carries the wire's 5m/1h cache-write split (see normalizeAnthropicUsage): the
      // proxy writes every breakpoint at a 1h TTL, which Anthropic bills at 2x input.
      usage: normalizeAnthropicUsage(final.usage as AnthropicUsage),
      ...(this.lastOrderedBlocks ? { replay: this.lastOrderedBlocks } : {}),
    };
  }

  /** The verbatim-replay channel from the last stream (see the field). */
  capturedOrderedBlocks(): AnthropicReplayBlock[] | undefined {
    return this.lastOrderedBlocks;
  }

  computeCostUsd(usage: NormalizedUsage, model: string): number {
    // The claim is a charge: the 1-hour write price follows BILL_CACHE_WRITE_1H_V1, as the server's does.
    return computeAnthropicCostUsd(chargeableAnthropicUsage(denormalizeAnthropicUsage(usage)), model);
  }

  pricedAtFailClosed(model: string): boolean {
    return anthropicPricesAtFailClosed(model);
  }

  buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary {
    return buildModelUsage(chargeableAnthropicUsage(denormalizeAnthropicUsage(usage)), model);
  }

  classifyError(err: unknown): TurnOutcome {
    return classifyAnthropicError(err);
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

  /** CONTEXT_APPEND_V1 (C7): the output_config.effort a loop request sends, from the request's own resolver. */
  reasoningEffort(model: string): string | undefined {
    return resolveAnthropicThinking(model, resolveCapabilities(model).maxOutputTokens)?.outputConfig?.effort;
  }

  defaultModel(): string {
    return 'claude-sonnet-5-5';
  }
}

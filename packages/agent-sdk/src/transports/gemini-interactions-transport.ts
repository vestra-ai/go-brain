/**
 * GeminiInteractionsTransport — the `Transport` (ModelPort) for Google's
 * Interactions API (`POST /v1beta/interactions`, SSE). The fifth wire dialect.
 *
 * STATELESS BY DESIGN (`store:false`, no `previous_interaction_id`): the journal is
 * the single source of truth, so compaction, resume-after-hibernate and cross-model
 * handoff keep working unchanged; Google's implicit cache reports
 * `total_cached_tokens`, so resending history is cheap. The price of statelessness is
 * the replay contract: every prior signed `thought` step must be resent verbatim,
 * which rides the `done` event's replay onto the assistant entry's `geminiSteps`
 * channel.
 *
 * Hand-rolled on `fetch` — no SDK dependency (the @google/genai SDK bakes in four
 * retries under our single retry authority). Delegates to:
 *   - gemini-interactions-messages    (journal → steps, content mappers, usage)
 *   - gemini-interactions-accumulator (the SSE fold)
 *   - gemini-transport                (the shared google.rpc error spec + rate table)
 *
 * Provider history is `GeminiInteractionsStep[]`; the stream is an async-iterable of
 * parsed SSE events.
 */
import type { ContentBlock, ImageBlock } from '../contract/blocks.js';
import type { GeminiReplayStep, JournalEntry } from '../contract/journal.js';
import type { ModelUsageSummary, TurnOutcome } from '../contract/turn-outcome.js';
import type { OutputFormat } from '../contract/output-format.js';
import type { CachePrefixHint } from '../contract/cache-prefix-hint.js';
import type { RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';
import { classifyAnthropicTermination } from '../engine/native-termination.js';
import { classifyProviderError } from '../engine/error-authority.js';
import { GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE } from '../engine/severed-recognizer.js';
import { withNarrationParam } from '../engine/tool-dispatcher.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderReplay,
  ProviderStream,
  ProviderTool,
  StreamEvent,
  Transport,
} from '../engine/transport.js';
import { GEMINI_ERROR_SPEC, geminiCanonicalCode, geminiErrorDetails } from './gemini-transport.js';
import { resolveGeminiRate } from '../contract/gemini-pricing.js';
import { toOpenAIToolJsonSchema } from './openai-tool-schema.js';
import { sanitizeGeminiToolParameters } from './gemini-tool-schema.js';
import { resolveGeminiThinking } from './thinking-support.js';
import { materializeGeminiInteractionsBody } from './gemini-inline.js';
import { prewarmBaseUrl, warmFetchInit } from './warm-connections.js';
import { apiPlaneRoute, LaneMove } from './lane-fallback.js';
import { silentDeathsEnabled, toolsMidstreamEnabled } from '../policy/feature-flags.js';
import { parseSseFrameOrSever } from './sse-frame.js';
import type { GeminiMediaDeps } from './gemini-files.js';
import { createGeminiInteractionsAccumulator } from './gemini-interactions-accumulator.js';
import type { MediaBlockForWire } from './gemini-interactions-messages.js';
import {
  GEMINI_INTERACTIONS_API,
  blocksToGeminiInteractionsContent,
  journalToGeminiInteractionsSteps,
  replayStepsToWire,
  toolResultToGeminiContent,
} from './gemini-interactions-messages.js';
import { ensureValidGeminiInteractionsSteps } from './gemini-interactions-validity.js';
import type {
  GeminiFunctionTool,
  GeminiInteractionsEvent,
  GeminiInteractionsRequest,
  GeminiInteractionsStep,
} from './gemini-interactions-wire.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Two documented credential kinds, never an environment branch (the Anthropic lane's
 * ANTHROPIC_AUTH_TOKEN-vs-ANTHROPIC_API_KEY shape):
 *   - GEMINI_AUTH_TOKEN → `Authorization: Bearer` to the credential proxy, which
 *     verifies the sandbox token and injects the real key as x-goog-api-key.
 *   - GEMINI_API_KEY    → `x-goog-api-key` to Google direct (local dev, the smoke).
 * Neither → no auth header: the proxy 401s, and no wrong-lane key is ever borrowed.
 */
export function geminiAuthHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.GEMINI_AUTH_TOKEN) return { authorization: `Bearer ${env.GEMINI_AUTH_TOKEN}` };
  if (env.GEMINI_API_KEY) return { 'x-goog-api-key': env.GEMINI_API_KEY };
  return {};
}

/** The lane root: the credential proxy when one is configured, else Google direct.
 *  The Files API rides the SAME root, so both derive it here. */
export function geminiBaseUrl(env: NodeJS.ProcessEnv): string {
  return env.GEMINI_BASE_URL || DEFAULT_BASE_URL;
}

function toGeminiFunctionTool(o: RawToolOptions): GeminiFunctionTool {
  // The sanitizer strips the keys Gemini's Schema validator rejects on the
  // generateContent lane (additionalProperties, $schema). Whether the Interactions
  // validator accepts full JSON Schema is an open probe item; sanitized is the safe
  // default either way (spec, Open items 1).
  return {
    type: 'function',
    name: o.name,
    description: o.description,
    parameters: sanitizeGeminiToolParameters(toOpenAIToolJsonSchema(o.parameters)),
  };
}

function findCallName(steps: GeminiInteractionsStep[], callId: string): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === 'function_call' && s.id === callId) return s.name;
  }
  return undefined;
}

/**
 * How often the media keep-alive speaks while a Files API upload holds the
 * request build. Well inside DEFAULT_STREAM_STALL_MS (180s) with room for the
 * guard's own clock, and slow enough that a cached resolution says nothing.
 */
export const GEMINI_MEDIA_KEEPALIVE_MS = 20_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/** The display name of the first media marker in a body, or undefined if it has none. */
function firstMediaMarkerName(body: GeminiInteractionsRequest): string | undefined {
  for (const step of body.input) {
    const items = step.type === 'user_input' ? step.content : step.type === 'function_result' ? step.result : undefined;
    if (!items) continue;
    for (const c of items) {
      const ref = (c as { vestraMediaRef?: { displayName?: unknown } }).vestraMediaRef;
      if (ref && typeof ref === 'object') {
        return typeof ref.displayName === 'string' && ref.displayName !== '' ? ref.displayName : 'the file';
      }
    }
  }
  return undefined;
}

/**
 * Keep the round AUDIBLE while a media upload runs.
 *
 * The stall guard (engine/stream-stall-guard.ts) races the FIRST `it.next()` of
 * this transport's readStream against a 180s idle bound, and the request build
 * for a media turn sits inside that first next(): a sha256 of the whole file, a
 * chunked upload, and up to 120s of ACTIVE polling. A large first upload would
 * therefore trip a false stall on a stream that is working perfectly.
 *
 * Silence is what the guard punishes, so the cure is to stop being silent. These
 * are LIVE-ONLY events: round-stream.ts:236-252 forwards `thinking_start` and
 * `thinking` to the sink (AGENT_THINKING_START / AGENT_THINKING_DELTA) and
 * journals only `thinking_block`, the signed kind, which this never emits. The
 * journal is untouched, and a turn with no media marker yields nothing at all.
 */
async function* mediaKeepAlive(
  settled: Promise<void>,
  label: string,
  everyMs: number,
  sleep: (ms: number) => Promise<void>,
): AsyncGenerator<StreamEvent> {
  // Registered BEFORE the race below, so a settle always wins the read of `done`.
  let done = false;
  void settled.then(() => {
    done = true;
  });
  let opened = false;
  for (;;) {
    await Promise.race([settled, sleep(everyMs)]);
    if (done) return;
    // Nothing is said until the FIRST tick: a cache hit resolves in a millisecond
    // and must leave the stream byte-identical to a turn with no media at all.
    if (!opened) {
      opened = true;
      yield { kind: 'thinking_start' };
    }
    yield { kind: 'thinking', text: `Preparing ${label} for the video model` };
  }
}

export interface GeminiInteractionsTransportOptions {
  /** Inject a stream factory for tests — bypasses fetch entirely. */
  streamFactory?: (body: GeminiInteractionsRequest, signal?: AbortSignal) => AsyncIterable<GeminiInteractionsEvent>;
  /**
   * VIDEO_UNDERSTANDING_V1 — the Files API client + workspace root that turn a
   * media block into a `files/<id>` reference at request build. Absent (the flag
   * off, or a construction that predates it) ⇒ a media item degrades to a text
   * placeholder naming the file, and the wire is byte-identical to today.
   */
  mediaDeps?: GeminiMediaDeps;
  /** Test seam: the media keep-alive cadence (default GEMINI_MEDIA_KEEPALIVE_MS). */
  mediaKeepAliveMs?: number;
  /** Test seam: the keep-alive's timer. */
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiInteractionsTransport implements Transport {
  readonly api = GEMINI_INTERACTIONS_API;
  readonly provider = 'google';

  private readonly streamFactory?: GeminiInteractionsTransportOptions['streamFactory'];
  /** LANE_FALLBACK_V1: this transport's move to its second route, while it holds. */
  private readonly laneMove = new LaneMove();
  /** Public so the construction site can be asserted: the flag's ONLY effect here. */
  readonly mediaDeps: GeminiMediaDeps | undefined;
  private readonly mediaKeepAliveMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The pending media resolution for a stream, read ONCE by readStream. */
  private readonly mediaWaitByStream = new WeakMap<object, { label: string; settled: Promise<void> }>();
  /** The LAST stream's steps verbatim (the journal fallback — see capturedGeminiSteps). */
  private lastSteps: GeminiReplayStep[] | undefined;

  constructor(opts: GeminiInteractionsTransportOptions = {}) {
    this.streamFactory = opts.streamFactory;
    this.mediaDeps = opts.mediaDeps;
    this.mediaKeepAliveMs = opts.mediaKeepAliveMs ?? GEMINI_MEDIA_KEEPALIVE_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** WARM_CONNECTIONS_V1: open the connection the next request will ride. */
  prewarm(): void {
    prewarmBaseUrl(() => (this.streamFactory ? undefined : this.laneMove.current() ?? geminiBaseUrl(process.env)));
  }

  /** LANE_FALLBACK_V1: move to the same proxy route on the API plane while the move holds (an injected stream has no route). */
  fallBackLane(_model?: string, until?: number): boolean {
    if (this.streamFactory) return false;
    return this.laneMove.move(apiPlaneRoute('google', geminiBaseUrl(process.env)), until);
  }

  emptyHistory(): ProviderHistory {
    return [] as GeminiInteractionsStep[];
  }

  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return journalToGeminiInteractionsSteps(entries);
  }

  pushAssistant(h: ProviderHistory, blocks: ContentBlock[], replay?: ProviderReplay): void {
    const steps = h as GeminiInteractionsStep[];
    // SEALED: the round's steps exactly as the provider sent them, carried on THIS
    // round's `done` event — so parallel subagents sharing one transport and the
    // empty-recovery seat's history copy each get their own round's turn, with no
    // per-instance or per-history stash to match up. Only the floor's repairs apply
    // (a sentinel thought where a call has no real one).
    if (replay && !Array.isArray(replay) && replay.dialect === 'gemini_interactions' && replay.steps.length > 0) {
      steps.push(...ensureValidGeminiInteractionsSteps(replayStepsToWire(replay.steps)));
      return;
    }
    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const out: GeminiInteractionsStep[] = [];
    if (text) out.push({ type: 'model_output', content: [{ type: 'text', text }] });
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        out.push({
          type: 'function_call',
          id: b.toolUseId,
          name: b.toolName,
          arguments: (b.toolInput ?? {}) as Record<string, unknown>,
        });
      }
    }
    steps.push(...ensureValidGeminiInteractionsSteps(out));
  }

  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    const steps = h as GeminiInteractionsStep[];
    const name = findCallName(steps, r.toolUseId);
    steps.push(
      ...ensureValidGeminiInteractionsSteps([
        {
          type: 'function_result',
          call_id: r.toolUseId,
          ...(name ? { name } : {}),
          result: toolResultToGeminiContent(r.blocks ?? [], r.text),
          ...(r.isError ? { is_error: true } : {}),
        },
      ]),
    );
  }

  /** `media` is widened to MediaBlockForWire: the `watch` tool hands per-call options
   *  (a clip range, a cheaper resolution) alongside the block, and a plain MediaBlock
   *  still satisfies it because every option is optional. */
  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], media?: MediaBlockForWire[]): void {
    const steps = h as GeminiInteractionsStep[];
    // The projection orders them (media, images, text); this list only has to be complete.
    const blocks: ContentBlock[] = [
      ...(media ?? []),
      ...(images ?? []),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ];
    steps.push(
      ...ensureValidGeminiInteractionsSteps([{ type: 'user_input', content: blocksToGeminiInteractionsContent(blocks) }]),
    );
  }

  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    // Narration parity: the same injection seam as every other arm (story spine
    // mint ladder tier-1). The dispatcher strips it before execution.
    return raw.map((o) => toGeminiFunctionTool(withNarrationParam(o))) as ProviderTool[];
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
    cacheKey?: string;
    noCacheWrite?: boolean;
    reasoningEffort?: 'low';
  }): ProviderStream {
    // A new call: the previous round's channel was read by the loop already.
    this.lastSteps = undefined;
    const tools = p.tools as GeminiFunctionTool[];
    const resolvedThinking = resolveGeminiThinking(p.model);
    // A side call may pin the floor (the memory sweep), only where thinking is sent at all.
    const thinking =
      resolvedThinking && p.reasoningEffort ? { ...resolvedThinking, thinking_level: p.reasoningEffort } : resolvedThinking;
    // cachePrefixHint / systemFleetPrefixChars / cacheKey / noCacheWrite are
    // IGNORED: Google's cache is automatic (no key, no breakpoints), so the body is
    // byte-identical whether they are set or not — the contract those fields promise.
    const body: GeminiInteractionsRequest = {
      model: p.model,
      input: p.history as GeminiInteractionsStep[],
      ...(p.system ? { system_instruction: p.system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      store: false,
      stream: true,
      generation_config: { max_output_tokens: p.maxTokens, ...(thinking ?? {}) },
      ...(p.outputFormat
        ? { response_format: { type: 'text' as const, mime_type: 'application/json' as const, schema: p.outputFormat.schema } }
        : {}),
    };
    // A media turn starts its request build NOW rather than on the first `next()`:
    // readStream has to be able to SEE that a resolution is in flight to keep the
    // stream audible for the stall guard, and it cannot see inside a generator it
    // has not started. A body with no marker keeps the lazy path unchanged.
    const label = firstMediaMarkerName(body);
    let eager: Promise<GeminiInteractionsRequest> | undefined;
    if (label !== undefined) {
      eager = materializeGeminiInteractionsBody(body, this.mediaDeps, p.signal) as Promise<GeminiInteractionsRequest>;
      // Observed here so a stream that is never iterated (the engine throwing
      // between callModel and readStream) cannot leave this rejection unhandled.
      eager.catch(() => {});
    }
    const buildBody = (): Promise<GeminiInteractionsRequest> =>
      eager ?? (materializeGeminiInteractionsBody(body, this.mediaDeps, p.signal) as Promise<GeminiInteractionsRequest>);

    let stream: AsyncGenerator<GeminiInteractionsEvent>;
    if (this.streamFactory) {
      // The media wire pass runs on the factory path too — tests see the SAME body
      // the real fetch would send. The factory's stream is an async iterable, so
      // the async hop stays invisible to consumers.
      const factory = this.streamFactory;
      stream = (async function* () {
        yield* factory(await buildBody(), p.signal);
      })();
    } else {
      stream = this.streamSSE(buildBody, p.signal);
    }
    if (eager !== undefined && label !== undefined) {
      // A settle, never a rejection: the keep-alive only needs to know when to stop.
      this.mediaWaitByStream.set(stream, { label, settled: eager.then(() => {}, () => {}) });
    }
    return stream;
  }

  /** POST the request and yield each parsed SSE `data:` event. Fetch runs lazily on
   *  first iteration (this generator is returned synchronously from callModel). */
  private async *streamSSE(
    buildBody: () => Promise<GeminiInteractionsRequest>,
    signal?: AbortSignal,
  ): AsyncGenerator<GeminiInteractionsEvent> {
    const wireBody = await buildBody();
    const base = this.laneMove.current() ?? geminiBaseUrl(process.env);
    const res = await fetch(`${base}/v1beta/interactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...geminiAuthHeaders(process.env),
      },
      body: JSON.stringify(wireBody),
      ...(signal ? { signal } : {}),
      ...warmFetchInit(),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      const code = geminiCanonicalCode(detail);
      // The details are lifted off the RAW body: the message below is flattened for the log.
      const details = geminiErrorDetails(detail);
      // Google's error body for this endpoint is itself SSE-shaped (`event: error\ndata:
      // {...}`); flattened so the whole 400 reads on ONE log line instead of wrapping.
      throw Object.assign(new Error(`Gemini Interactions ${res.status}: ${detail.replace(/\s+/g, ' ').trim()}`), {
        status: res.status,
        headers: res.headers,
        ...(code !== undefined ? { code } : {}),
        ...(details !== undefined ? { details } : {}),
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (json === '' || json === '[DONE]') continue;
        if (silentDeathsEnabled()) {
          yield parseSseFrameOrSever<GeminiInteractionsEvent>(json, reader, GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE);
          continue;
        }
        try {
          yield JSON.parse(json) as GeminiInteractionsEvent;
        } catch {
          // skip a torn SSE frame rather than crash the turn
        }
      }
    }
  }

  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const s = stream as AsyncIterable<GeminiInteractionsEvent>;
    // The media resolution was started in callModel and may still be running. Speak
    // while it does, so the stall guard hears a working stream rather than silence
    // (see mediaKeepAlive). Read once — a re-read of the same stream is not a thing.
    const wait = this.mediaWaitByStream.get(stream as object);
    if (wait !== undefined) {
      this.mediaWaitByStream.delete(stream as object);
      yield* mediaKeepAlive(wait.settled, wait.label, this.mediaKeepAliveMs, this.sleep);
    }
    const acc = createGeminiInteractionsAccumulator();
    // L1 (TOOLS_MIDSTREAM_V1): a call is ready at its step.stop. Off: no event.
    const midstream = toolsMidstreamEnabled();
    for await (const ev of s) {
      for (const live of acc.onEvent(ev)) yield live;
      if (midstream) for (const toolUse of acc.takeReady()) yield { kind: 'tool_ready', toolUse };
    }
    const final = acc.final();
    if (final === null) {
      // The premature-end sentinel: registered in STREAM_END_SENTINELS so every
      // lane's recognizer re-issues the round instead of dying model_error.
      throw new Error(GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE);
    }
    const steps = acc.steps();
    this.lastSteps = steps;
    for (const c of acc.calls()) {
      yield { kind: 'tool_use', toolUse: { id: c.id, name: c.name, input: c.input } };
    }
    yield {
      kind: 'done',
      stopReason: final.stopReason,
      usage: final.usage,
      // The round's turn as sent, for every reader of THIS stream (see pushAssistant).
      ...(steps ? { replay: { dialect: 'gemini_interactions' as const, steps } } : {}),
    };
  }

  /**
   * The steps of the most recent stream this instance read — the FALLBACK channel.
   * The engine journals the `done` event's replay first (round-stream.ts); this
   * stash is only read when a round carried none, and never for a subagent.
   */
  capturedGeminiSteps(): GeminiReplayStep[] | undefined {
    return this.lastSteps;
  }

  computeCostUsd(usage: NormalizedUsage, model: string): number {
    const { inPerM, cachedPerM, outPerM } = resolveGeminiRate(model).price;
    // The single convention: inputTokens is EXCLUSIVE of the cached bucket, so the
    // three buckets are simply additive (no subtraction at the price site).
    const cached = usage.cacheReadInputTokens ?? 0;
    return (usage.inputTokens / 1e6) * inPerM + (cached / 1e6) * cachedPerM + (usage.outputTokens / 1e6) * outPerM;
  }

  buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary {
    return {
      [model]: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        webSearchRequests: 0,
        costUSD: this.computeCostUsd(usage, model),
      },
    };
  }

  classifyError(err: unknown): TurnOutcome {
    return classifyProviderError(err, GEMINI_ERROR_SPEC, 'streaming');
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

  /** CONTEXT_APPEND_V1 (C7): the thinking level a loop request sends, from the request's own resolver. */
  reasoningEffort(model: string): string | undefined {
    return resolveGeminiThinking(model)?.thinking_level;
  }

  defaultModel(): string {
    return 'gemini-3.8-flash';
  }
}

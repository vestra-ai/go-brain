/**
 * GeminiTransport — the `Transport` (ModelPort) for the Gemini native wire dialect.
 *
 * The fourth target dialect. Implemented against the Gemini REST API
 * (`:streamGenerateContent?alt=sse`) so it adds NO new SDK dependency; the wire
 * types are declared explicitly (see request-validity GeminiContent/Part and
 * gemini-messages). Delegates to:
 *   - gemini-messages   (journal → contents, the SSE stream accumulator)
 *   - native-termination (shared HTTP-status error + stopReason classifiers,
 *                         fed a mapped Gemini finishReason)
 *
 * Provider history is `GeminiContent[]` (opaque `ProviderHistory` to the loop);
 * the stream is an async-iterable of parsed `GeminiStreamChunk`.
 */

import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import type { JournalEntry } from '../contract/journal.js';
import type { ModelUsageSummary, TurnOutcome } from '../contract/turn-outcome.js';
import type { RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';
import {
  journalToGeminiContents,
  blocksToGeminiParts,
  createGeminiAccumulator,
  type GeminiStreamChunk,
} from './gemini-messages.js';
import { toOpenAIToolJsonSchema } from './openai-tool-schema.js';
import { sanitizeGeminiToolParameters } from './gemini-tool-schema.js';
import { materializeGeminiBody } from './gemini-inline.js';
import { prewarmBaseUrl, warmFetchInit } from './warm-connections.js';
import { silentDeathsEnabled, toolsMidstreamEnabled } from '../policy/feature-flags.js';
import { parseSseFrameOrSever } from './sse-frame.js';
import { classifyAnthropicTermination } from '../engine/native-termination.js';
import { classifyProviderError, type ProviderErrorSpec } from '../engine/error-authority.js';
import type { SeveranceSpec } from '../engine/severed-recognizer.js';
import { GEMINI_SEVERED_STREAM_MESSAGE } from '../engine/severed-recognizer.js';
import { withNarrationParam } from '../engine/tool-dispatcher.js';
import type { GeminiContent, GeminiPart } from '../engine/request-validity.js';
import { ensureValidGeminiRequest, isSendableGeminiTurn } from '../engine/request-validity.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderReplay,
  ProviderStream,
  ProviderTool,
  StreamEvent,
  Transport,
} from '../engine/transport.js';

/** A Gemini function-declaration tool (one entry under `tools[].functionDeclarations`). */
interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: unknown;
}

function toGeminiFunctionDeclaration(o: RawToolOptions): GeminiFunctionDeclaration {
  // PR5 — sanitize to the Gemini `Schema` subset. `toOpenAIToolJsonSchema` emits
  // `additionalProperties` (+ `$schema`, typed enums) which Gemini's validator rejects
  // → without this every functionDeclarations list 400s and the Gemini arm can't run
  // a single tool. The sanitizer strips the unsupported keys recursively.
  return {
    name: o.name,
    description: o.description,
    parameters: sanitizeGeminiToolParameters(toOpenAIToolJsonSchema(o.parameters)),
  };
}

/** Map a Gemini finishReason to the shared classifier's stopReason vocabulary. */
function mapFinishReason(reason: string | null): string | null {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'PROHIBITED_CONTENT') return 'refusal';
  return reason; // STOP / null → clean completion
}

/**
 * The Gemini dialect's SEVERANCE SPEC. There is no SDK: the transport is
 * hand-rolled on `fetch`, so no abort/connection wrapper CLASSES exist — an
 * aborted fetch rejects with the platform AbortError (the policy's name check),
 * and a connection death surfaces as undici's TypeError('fetch failed') with the
 * socket code down `cause`, which the recognizer's shared socket walk and the
 * policy's network net already cover. The premature-end sentinel rides the shared
 * STREAM_END_SENTINELS registry like every lane's.
 */
export const GEMINI_SEVERANCE_SPEC: SeveranceSpec = {
  isAbort: (err) => (err as { name?: unknown } | null | undefined)?.name === 'AbortError',
  isConnectionError: () => false,
};

/**
 * The Gemini dialects' ERROR SPEC (generateContent AND Interactions share
 * google.rpc bodies) — per-transport FACTS; the policy lives once in
 * engine/error-authority.ts. Until this spec the lane delegated to
 * classifyAnthropicError — the WRONG SDK's classes: its instanceof arms could
 * never match, so only the status ladder and Anthropic's 400 prose ever fired.
 *
 * The typed code is google.rpc.Status's canonical string, lifted from the REST
 * error body (`{"error":{"code":<http>,"message":…,"status":"<CANONICAL>"}}`) by
 * streamSSE's throw site. Rows follow the canonical HTTP pairing (google.rpc
 * code.proto; ai.google.dev/gemini-api docs: 429 RESOURCE_EXHAUSTED = rate limit
 * (a 402 RESOURCE_EXHAUSTED, the empty prepaid balance, never reaches this row: the
 * policy reads a 402 before any code), 503 UNAVAILABLE = overloaded-retry-later,
 * 400 FAILED_PRECONDITION = free tier
 * unavailable / enable billing), each statusFallback being that pairing so a
 * status-less lift of the same frame lands identically. INVALID_ARGUMENT has NO
 * row on purpose: a Gemini 400 can be a context overflow, an image rejection, or
 * plain validation — only the message distinguishes them, so the two generic
 * prose rules below (the ones whose wording Gemini bodies actually carry; the
 * Anthropic-only credit/image-count wordings were dropped with the borrow) decide.
 */
export const GEMINI_ERROR_SPEC: ProviderErrorSpec = {
  name: 'gemini',
  abortClasses: [],
  codeOf: (err) => {
    const c = (err as { code?: unknown } | null | undefined)?.code;
    return typeof c === 'string' ? c : undefined;
  },
  codes: {
    RESOURCE_EXHAUSTED: { kind: 'rate_limited', statusFallback: 429 },
    UNAVAILABLE: { kind: 'model_unavailable', statusFallback: 503 },
    INTERNAL: { kind: 'model_unavailable', statusFallback: 500 },
    DEADLINE_EXCEEDED: { kind: 'model_unavailable', statusFallback: 504 },
    NOT_FOUND: { kind: 'model_unavailable', statusFallback: 404 },
    PERMISSION_DENIED: { kind: 'auth_error', statusFallback: 403 },
    UNAUTHENTICATED: { kind: 'auth_error', statusFallback: 401 },
    FAILED_PRECONDITION: { kind: 'billing_error', statusFallback: 400 },
    // The Interactions streaming `error` event carries a lowercase code the transport
    // upper-cases (gateway_timeout → GATEWAY_TIMEOUT). Same retry class as UNAVAILABLE.
    GATEWAY_TIMEOUT: { kind: 'model_unavailable', statusFallback: 504 },
  },
  messageRules: [
    {
      name: 'context_too_long',
      on: [400],
      kind: 'context_exceeded',
      statusFallback: 400,
      test: (m) => /too long|context|maximum.*tokens|token count/i.test(m),
    },
    {
      name: 'image_rejected',
      on: [400],
      kind: 'image_error',
      statusFallback: 400,
      test: (m) =>
        /\bimage\b/i.test(m) &&
        /could not process|unsupported|invalid|exceeds|does not match|too large|unable to/i.test(m),
    },
  ],
  severance: GEMINI_SEVERANCE_SPEC,
};

/** Lift google.rpc.Status's canonical code out of a REST error body (object or the
 *  streaming endpoint's array form). A non-JSON body (proxy HTML) yields none and
 *  the status ladder rules alone. */
export function geminiCanonicalCode(detail: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(detail);
    const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
    const status = (first as { error?: { status?: unknown } } | null | undefined)?.error?.status;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}

/** Lift google.rpc.Status's `details` (QuotaFailure, RetryInfo, …) out of an error body: the
 *  REST object or array form, or the Interactions endpoint's SSE framing, where each `data:`
 *  line is its own JSON document. Read off the RAW body, before any log flattening. The first
 *  document carrying a details array wins; none (proxy HTML, no details) yields undefined. */
export function geminiErrorDetails(detail: string): unknown[] | undefined {
  const dataLines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length));
  for (const doc of [detail, ...dataLines]) {
    try {
      const parsed: unknown = JSON.parse(doc);
      const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
      const details = (first as { error?: { details?: unknown } } | null | undefined)?.error?.details;
      if (Array.isArray(details)) return details;
    } catch {
      // not a JSON document; try the next one
    }
  }
  return undefined;
}

// The Gemini rate card lives in the PURE CONTRACT (contract/gemini-pricing.ts):
// a rate lookup must be reachable from the root without importing this barrel,
// which server tests mock wholesale — see that file's header for the incident.
// Imported for `rateFor` below and RE-EXPORTED so this module's surface, and the
// `@vestra/agent-sdk/transports` barrel's, are byte-identical to before the move.
import { resolveGeminiRate } from '../contract/gemini-pricing.js';
export { resolveGeminiRate } from '../contract/gemini-pricing.js';
export type { GeminiTokenPrice, GeminiRateResolution } from '../contract/gemini-pricing.js';

/** This lane's base URL, read per request (the credential proxy when one is set). */
function legacyGeminiBaseUrl(): string {
  return process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com';
}

function rateFor(model: string): { inPerM: number; cachedPerM: number; outPerM: number } {
  const { inPerM, cachedPerM, outPerM } = resolveGeminiRate(model).price;
  return { inPerM, cachedPerM, outPerM };
}

export interface GeminiTransportOptions {
  /** Inject a stream factory for tests — bypasses fetch entirely. */
  streamFactory?: (model: string, body: unknown, signal?: AbortSignal) => AsyncIterable<GeminiStreamChunk>;
}

export class GeminiTransport implements Transport {
  readonly api = 'gemini';
  readonly provider = 'google';

  private readonly streamFactory?: GeminiTransportOptions['streamFactory'];
  /**
   * The in-memory history's calls by tool_use id → the name (and provider call id)
   * its functionResponse must carry. Keyed by the HISTORY, never this instance: a
   * subagent on the parent's model shares the parent's transport, in parallel.
   */
  private readonly callsByHistory = new WeakMap<object, Map<string, GeminiCallRef>>();
  constructor(opts: GeminiTransportOptions = {}) {
    this.streamFactory = opts.streamFactory;
  }

  /** WARM_CONNECTIONS_V1: open the connection the next request will ride. */
  prewarm(): void {
    prewarmBaseUrl(() => (this.streamFactory ? undefined : legacyGeminiBaseUrl()));
  }

  private callsFor(h: ProviderHistory): Map<string, GeminiCallRef> {
    const key = h as object;
    let calls = this.callsByHistory.get(key);
    if (!calls) this.callsByHistory.set(key, (calls = new Map()));
    return calls;
  }

  emptyHistory(): ProviderHistory {
    return [] as GeminiContent[];
  }

  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return journalToGeminiContents(entries);
  }

  pushAssistant(h: ProviderHistory, blocks: ContentBlock[], replay?: ProviderReplay): void {
    const contents = h as GeminiContent[];
    const calls = this.callsFor(h);
    // SEALED: the round's model turn exactly as the provider streamed it (the `done`
    // event's replay). The rebuild below drops every thoughtSignature — ToolUseBlock
    // has no field for one — and Gemini 3 400s that on the very next request
    // ("Function call is missing a thought_signature", probed 2026-09-23), on every
    // retry: the permanent wedge of the subagent and no-journal paths.
    const sealed = replay && !Array.isArray(replay) && replay.dialect === 'gemini' ? replay.content : undefined;
    if (sealed && isSendableGeminiTurn(sealed.parts as GeminiPart[])) {
      let k = 0;
      for (const part of sealed.parts as GeminiPart[]) {
        if (!part.functionCall) continue;
        const toolUseId = sealed.callIds[k++];
        if (toolUseId !== undefined) {
          calls.set(toolUseId, { name: part.functionCall.name, ...(part.functionCall.id ? { id: part.functionCall.id } : {}) });
        }
      }
      contents.push({ role: 'model', parts: [...(sealed.parts as GeminiPart[])] });
      return;
    }
    for (const b of blocks) if (b.type === 'tool_use') calls.set(b.toolUseId, { name: b.toolName });
    const parts = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => ({ text: b.text }));
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        parts.push({ functionCall: { name: b.toolName, args: b.toolInput ?? {} } } as never);
      }
    }
    contents.push(...ensureValidGeminiRequest([{ role: 'model', parts }]));
  }

  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    // Gemini matches a functionResponse to its call by NAME (and by the provider's
    // call `id` when the call carried one). The dispatch result carries only our
    // toolUseId, so the call is looked up BY THAT ID in what pushAssistant recorded
    // for this history — the old "last functionCall in history" read labeled every
    // result of a parallel batch with the LAST call's name.
    const contents = h as GeminiContent[];
    const call = this.callsByHistory.get(h as object)?.get(r.toolUseId) ?? nextUnansweredCall(contents);
    const name = call?.name ?? r.toolUseId;
    contents.push(
      ...ensureValidGeminiRequest([
        {
          role: 'user',
          parts: [{ functionResponse: { name, response: { output: r.text }, ...(call?.id ? { id: call.id } : {}) } }],
        },
      ]),
    );
  }

  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], _media?: MediaBlock[]): void {
    const contents = h as GeminiContent[];
    const blocks: ContentBlock[] = [
      ...(images ?? []),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ];
    contents.push({ role: 'user', parts: blocksToGeminiParts(blocks) });
  }

  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    // Narration parity: same injection seam as the Anthropic arm (story spine
    // mint ladder tier-1). The dispatcher strips it before execution.
    return raw.map((o) => toGeminiFunctionDeclaration(withNarrationParam(o))) as ProviderTool[];
  }

  callModel(p: {
    model: string;
    system: string;
    tools: ProviderTool[];
    history: ProviderHistory;
    signal?: AbortSignal;
    maxTokens: number;
  }): ProviderStream {
    const decls = p.tools as GeminiFunctionDeclaration[];
    const body = {
      contents: p.history as GeminiContent[],
      ...(p.system ? { system_instruction: { parts: [{ text: p.system }] } } : {}),
      ...(decls.length > 0 ? { tools: [{ functionDeclarations: decls }] } : {}),
      generationConfig: { maxOutputTokens: p.maxTokens },
    };
    if (this.streamFactory) {
      // Media-refs S1: the wire pass (edge inline + internal-marker strip) must
      // run on the factory path too — tests injecting a factory see the SAME
      // body the real fetch would send. The factory's stream is an async
      // iterable, so the async hop stays invisible to consumers.
      const factory = this.streamFactory;
      return (async function* () {
        yield* factory(
          p.model,
          await materializeGeminiBody(body),
          p.signal,
        ) as AsyncIterable<GeminiStreamChunk>;
      })();
    }
    return this.streamSSE(p.model, body, p.signal);
  }

  /** POST the request and yield each parsed SSE `data:` chunk. Fetch runs lazily on
   *  first iteration (this generator is returned synchronously from callModel). */
  private async *streamSSE(
    model: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<GeminiStreamChunk> {
    // Media-refs S1: edge inline url-only images + strip the internal
    // vestraImageUrl marker (every flag state) — the FIRST await, so the lazy
    // generator contract (fetch runs on first iteration) is unchanged.
    const wireBody = await materializeGeminiBody(body);
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
    const url = `${legacyGeminiBaseUrl()}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(wireBody),
      ...(signal ? { signal } : {}),
      ...warmFetchInit(),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      const code = geminiCanonicalCode(detail);
      const details = geminiErrorDetails(detail);
      throw Object.assign(new Error(`Gemini ${res.status}: ${detail}`), {
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
          yield parseSseFrameOrSever<GeminiStreamChunk>(json, reader, GEMINI_SEVERED_STREAM_MESSAGE);
          continue;
        }
        try {
          yield JSON.parse(json) as GeminiStreamChunk;
        } catch {
          // skip a torn SSE frame rather than crash the turn
        }
      }
    }
  }

  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const s = stream as AsyncIterable<GeminiStreamChunk>;
    const acc = createGeminiAccumulator();
    // L1 (TOOLS_MIDSTREAM_V1): a call is ready in the chunk that carries it. Off: no event.
    const midstream = toolsMidstreamEnabled();
    for await (const chunk of s) {
      acc.onChunk(chunk);
      const think = acc.thinkingDelta(chunk);
      if (think !== null) yield { kind: 'thinking', text: think };
      const delta = acc.textDelta(chunk);
      if (delta !== null) yield { kind: 'text', text: delta };
      if (midstream) for (const toolUse of acc.takeReady()) yield { kind: 'tool_ready', toolUse };
    }
    const final = acc.final();
    if (final === null) {
      // The premature-end sentinel. It lives in the engine's shared registry, so
      // EVERY lane's recognizer classifies it as a severance and the round is
      // re-issued instead of dying model_error (this lane was dark until 08-20).
      throw new Error(GEMINI_SEVERED_STREAM_MESSAGE);
    }
    for (const tu of acc.toolUses()) {
      yield {
        kind: 'tool_use',
        toolUse: {
          id: tu.id,
          name: tu.name,
          input: tu.input,
          // PR6 — carry the Gemini-3 thoughtSignature so the loop journals it.
          ...(tu.thoughtSignature ? { thoughtSignature: tu.thoughtSignature } : {}),
        },
      };
    }
    // The round's model turn as streamed rides the done event (see pushAssistant).
    const replay = acc.replay();
    yield {
      kind: 'done',
      stopReason: mapFinishReason(final.stopReason),
      usage: final.usage,
      ...(replay ? { replay: { dialect: 'gemini' as const, content: replay } } : {}),
    };
  }

  computeCostUsd(usage: NormalizedUsage, model: string): number {
    const { inPerM, cachedPerM, outPerM } = rateFor(model);
    // C5: the single convention (normalizeGeminiUsage subtracts the cached bucket at the
    // producer, BILL-04's discount intact), so the three buckets are simply additive here,
    // exactly as the Interactions lane and the server's pricer price them.
    const cached = usage.cacheReadInputTokens ?? 0;
    return (
      (usage.inputTokens / 1e6) * inPerM +
      (cached / 1e6) * cachedPerM +
      (usage.outputTokens / 1e6) * outPerM
    );
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

  defaultModel(): string {
    return 'gemini-2.5-pro';
  }
}

/** What a functionResponse needs from its call. */
interface GeminiCallRef {
  name: string;
  /** The provider's call id, when the call carried one. */
  id?: string;
}

/**
 * The fallback for a history pushAssistant never recorded (a copy): Gemini's own
 * pairing rule — the results answer the latest call turn's calls in order — so the
 * next result answers the first call not yet answered.
 */
function nextUnansweredCall(contents: GeminiContent[]): GeminiCallRef | undefined {
  let answered = 0;
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c.role === 'user') {
      answered += c.parts.filter((p) => p.functionResponse).length;
      continue;
    }
    const fc = c.parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    if (fc.length === 0) return undefined;
    const call = fc[answered];
    return call ? { name: call.name, ...(call.id ? { id: call.id } : {}) } : undefined;
  }
  return undefined;
}

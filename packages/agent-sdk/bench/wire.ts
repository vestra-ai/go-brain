/**
 * wire — replay a recording through a REAL wire transport and keep every request
 * body it would have sent.
 *
 * The real transport (Anthropic Messages, OpenAI Responses, Chat Completions, Gemini,
 * Gemini Interactions) owns the history shape, the tool schemas and the request
 * build, through the same injection seam its own unit tests use (a client double or
 * a stream factory), so nothing leaves the process. The recording still answers
 * every call: the replay transport serves the round, classifies the recorded faults
 * and prices the recorded usage, so the loop runs exactly as the recording ran and
 * only the wire differs.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { ContentBlock, ImageBlock, MediaBlock } from '../src/contract/blocks.js';
import type { JournalEntry } from '../src/contract/journal.js';
import type { ModelUsageSummary } from '../src/contract/turn-outcome.js';
import type { ReplayTransport } from '../src/engine/replay/replay-transport.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderReplay,
  ProviderStream,
  ProviderTool,
  StreamEvent,
  Transport,
} from '../src/engine/transport.js';
import type { RawToolOptions, ToolDispatchResult } from '../src/tools/tool-types.js';
import {
  AnthropicMessagesTransport,
  ChatCompletionsTransport,
  GeminiInteractionsTransport,
  GeminiTransport,
  OpenAIResponsesTransport,
} from '../src/transports/index.js';
import type { WireFormat } from './fixtures.js';

async function* nothing(): AsyncGenerator<never> {}

/** A real transport for `wire` whose provider call hands its request body to `capture`. */
function realTransport(wire: WireFormat, capture: (body: unknown) => void): Transport {
  const stream = (body: unknown) => {
    capture(body);
    return nothing();
  };
  switch (wire) {
    case 'anthropic_messages':
      return new AnthropicMessagesTransport({ client: { messages: { stream } } as unknown as Anthropic });
    case 'openai_responses':
      return new OpenAIResponsesTransport({ client: { responses: { stream } } as unknown as OpenAI });
    case 'openai_chat_completions':
      return new ChatCompletionsTransport({ client: { chat: { completions: { stream } } } as unknown as OpenAI });
    case 'gemini':
      return new GeminiTransport({ streamFactory: (_model, body) => stream(body) });
    case 'gemini_interactions':
      return new GeminiInteractionsTransport({ streamFactory: (body) => stream(body) });
  }
}

type BenchStream = { wire: ProviderStream; replay: ProviderStream };

export class BenchTransport implements Transport {
  readonly api: string;
  readonly provider: string;
  /** Every request body, serialized at send time (a Gemini body holds the live history array). */
  readonly bodies: string[] = [];
  /** Time spent serializing bodies: bench bookkeeping, subtracted from harness time. */
  overheadMs = 0;
  private readonly wire: Transport;
  /** The provider's own replay channels only flow when the recording speaks this wire's dialect. */
  private readonly ownDialect: boolean;

  constructor(wire: WireFormat, private readonly replay: ReplayTransport) {
    this.wire = realTransport(wire, (body) => {
      const t0 = performance.now();
      this.bodies.push(JSON.stringify(body));
      this.overheadMs += performance.now() - t0;
    });
    this.api = this.wire.api;
    this.provider = this.wire.provider;
    this.ownDialect = replay.api === this.wire.api;
  }

  emptyHistory(): ProviderHistory {
    return this.wire.emptyHistory();
  }
  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return this.wire.historyFromJournal(entries);
  }
  pushAssistant(h: ProviderHistory, blocks: ContentBlock[], replay?: ProviderReplay): void {
    this.wire.pushAssistant(h, blocks, replay);
  }
  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    this.wire.pushToolResult(h, r);
  }
  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], media?: MediaBlock[]): void {
    this.wire.pushUser(h, text, images, media);
  }
  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    return this.wire.buildTools(raw);
  }
  callModel(p: Parameters<Transport['callModel']>[0]): ProviderStream {
    return { wire: this.wire.callModel(p), replay: this.replay.callModel(p) } satisfies BenchStream;
  }
  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const s = stream as BenchStream;
    // Drain the (empty) wire stream first: the Gemini lanes build their body lazily.
    for await (const _ of s.wire as AsyncIterable<unknown>) void _;
    yield* this.replay.readStream(s.replay);
  }
  capturedReasoning(): ReturnType<NonNullable<Transport['capturedReasoning']>> {
    return this.ownDialect ? this.replay.capturedReasoning() : [];
  }
  capturedOrderedBlocks(): ReturnType<NonNullable<Transport['capturedOrderedBlocks']>> {
    return this.ownDialect ? this.replay.capturedOrderedBlocks() : undefined;
  }
  computeCostUsd(usage: NormalizedUsage, model: string): number {
    return this.replay.computeCostUsd(usage, this.priceAs(model));
  }
  buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary {
    return this.replay.buildModelUsage(usage, this.priceAs(model));
  }
  /** The bench measures size, never cost: the recorded usage prices on the replay's own rate card. */
  private priceAs(model: string): string {
    return this.wire.api === 'anthropic_messages' ? model : this.replay.defaultModel();
  }
  classifyError(err: unknown): ReturnType<Transport['classifyError']> {
    return this.replay.classifyError(err);
  }
  classifyTermination(a: Parameters<Transport['classifyTermination']>[0]): ReturnType<Transport['classifyTermination']> {
    return this.replay.classifyTermination(a);
  }
  defaultModel(): string {
    return this.wire.defaultModel();
  }
}

/** A request split the way a provider caches it: prefix items, then history items. */
export interface Anatomy {
  system: unknown[];
  tools: unknown[];
  history: unknown[];
  /** Cache render order: Anthropic renders tools before system; the others system first. */
  order: unknown[];
}

type Body = Record<string, unknown> & { messages?: unknown[]; tools?: unknown[] };

export function anatomy(wire: WireFormat, raw: string): Anatomy {
  const b = JSON.parse(raw) as Body;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  let system: unknown[];
  let tools = list(b.tools);
  let history: unknown[];
  if (wire === 'anthropic_messages') {
    [system, history] = [list(b.system), list(b.messages)];
  } else if (wire === 'openai_responses') {
    [system, history] = [list(b.instructions), list(b.input)];
  } else if (wire === 'openai_chat_completions') {
    const [sys, ...rest] = list(b.messages);
    [system, history] = [list(sys), rest];
  } else if (wire === 'gemini') {
    tools = tools.flatMap((t) => list((t as { functionDeclarations?: unknown }).functionDeclarations));
    [system, history] = [list(b.system_instruction), list(b.contents)];
  } else {
    [system, history] = [list(b.system_instruction), list(b.input)];
  }
  const order = wire === 'anthropic_messages' ? [...tools, ...system, ...history] : [...system, ...tools, ...history];
  return { system, tools, history, order };
}

/** A tool the provider holds out of context until searched for (Anthropic defer_loading). */
export const inContext = (tool: unknown): boolean => (tool as { defer_loading?: unknown }).defer_loading !== true;

/** An item's cache identity: its bytes without breakpoint markers (moving a marker busts nothing). */
export const cacheKeyOf = (item: unknown): string =>
  JSON.stringify(item, (k, v: unknown) => (k === 'cache_control' ? undefined : v));

/**
 * Share of request `next` (by bytes, in cache render order) that is an identical
 * leading run of request `prev`: what a prefix cache could serve from the previous call.
 */
export function stableShare(prev: Anatomy, next: Anatomy): number {
  const a = prev.order.map(cacheKeyOf);
  const b = next.order.map(cacheKeyOf);
  const bytes = b.map((x) => Buffer.byteLength(x));
  const total = bytes.reduce((s, n) => s + n, 0);
  let same = 0;
  for (let i = 0; i < b.length && i < a.length && a[i] === b[i]; i++) same += bytes[i];
  return total === 0 ? 1 : same / total;
}

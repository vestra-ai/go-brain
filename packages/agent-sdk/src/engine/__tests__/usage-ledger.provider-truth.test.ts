/**
 * C5 (harness to nine) — the token ledger uses the provider's numbers.
 *
 * One model call per wire format, through the REAL transport and the REAL engine, with the
 * provider's usage payload in the shape each provider reports it (the cache conventions
 * differ: Anthropic's input is exclusive, OpenAI's and Fireworks' and Google's include the
 * cached share, xAI excludes reasoning from completion, Google bills thoughts as output).
 * The usage event the engine yields goes through the SAME wire mapping the sandbox sink
 * emits and the server writes to task_turn_usage (contract/usage-wire.ts), and three things
 * must hold on every lane:
 *   1. the row is the provider's numbers: uncached, cached, written, output, reasoning;
 *   2. nothing is lost or counted twice: uncached + cached + written = the provider's prompt;
 *   3. no recomputation drift: the server's price of the row (priceUsageUsd over the wire,
 *      the BILLING_SERVER_REPRICE_V1 path) equals the runner's claimed cost of the round.
 *
 * Revert-proof: generateContent's inclusive input (gemini-messages.ts before C5) fails 2 and
 * 3 on its lane; dropping the reasoning carry fails 1 on the Chat Completions and Gemini lanes.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { NativeHarness } from '../native-harness.js';
import type { Transport } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { NativeConfig } from '../native-config.js';
import { chargeableTokenUsage, priceUsageUsd } from '../../contract/usage-pricing.js';
import { toAgentUsageWire, tokenUsageFromWire } from '../../contract/usage-wire.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';

const ANSWER = 'Priya is your cofounder at Acme.';
const asyncOf = <T>(it: Iterable<T>) =>
  (async function* () {
    yield* it;
  })();

/** What the provider said, in ledger terms: the row must read exactly this. */
interface Ledger {
  uncached: number;
  cached: number;
  written: number;
  output: number;
  reasoning: number | undefined;
}

interface Lane {
  name: string;
  model: string;
  /** The provider's total prompt tokens (every input bucket together). */
  prompt: number;
  ledger: Ledger;
  /** A real transport whose client plays one final-answer round carrying the provider's usage. */
  transport(): Transport;
}

function responsesTransport(usage: Record<string, unknown>): Transport {
  const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: ANSWER, annotations: [] }] };
  const client = {
    baseURL: 'https://capture.invalid/v1',
    responses: {
      stream: () => asyncOf([
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: ANSWER },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: { status: 'completed', output: [message], usage } },
      ]),
    },
  } as unknown as OpenAI;
  return new OpenAIResponsesTransport({ client });
}

function chatTransport(usage: Record<string, unknown>): Transport {
  const client = {
    baseURL: 'https://capture.invalid/v1',
    chat: {
      completions: {
        stream: () => asyncOf([
          { choices: [{ index: 0, delta: { content: ANSWER } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage },
        ]),
      },
    },
  } as unknown as OpenAI;
  return new ChatCompletionsTransport({ client });
}

function anthropicTransport(usage: Record<string, unknown>): Transport {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } },
    { type: 'content_block_stop', index: 0 },
  ];
  const client = {
    messages: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
        async finalMessage() {
          return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: ANSWER }] };
        },
      }),
    },
  };
  return new AnthropicMessagesTransport({ client: client as never });
}

function interactionsTransport(usage: Record<string, unknown>): Transport {
  return new GeminiInteractionsTransport({
    streamFactory: () => asyncOf([
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: ANSWER } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i1', status: 'completed', usage } },
    ]) as never,
  });
}

function generateTransport(usageMetadata: Record<string, unknown>): Transport {
  return new GeminiTransport({
    streamFactory: () => asyncOf([
      { candidates: [{ content: { role: 'model', parts: [{ text: ANSWER }] }, finishReason: 'STOP' }], usageMetadata },
    ]) as never,
  });
}

/** One prompt everywhere: 1,200 fresh tokens, 40,000 read from cache, 5,000 written where the provider sells writes. */
const LANES: Lane[] = [
  {
    name: 'Anthropic Messages: input EXCLUSIVE, a 1-hour cache write',
    model: 'claude-sonnet-5-5',
    prompt: 46_200,
    ledger: { uncached: 1_200, cached: 40_000, written: 5_000, output: 350, reasoning: undefined },
    transport: () => anthropicTransport({
      input_tokens: 1_200, output_tokens: 350, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 5_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5_000 },
    }),
  },
  {
    name: 'OpenAI Responses: input INCLUDES cached and written; reasoning inside output',
    model: 'gpt-6.1-sol',
    prompt: 46_200,
    ledger: { uncached: 1_200, cached: 40_000, written: 5_000, output: 350, reasoning: 200 },
    transport: () => responsesTransport({
      input_tokens: 46_200, input_tokens_details: { cached_tokens: 40_000, cache_write_tokens: 5_000 },
      output_tokens: 350, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 46_550,
    }),
  },
  {
    name: 'Chat Completions on Fireworks: prompt INCLUDES cached; reasoning inside completion',
    model: 'deepseek-v4.1-flash',
    prompt: 41_200,
    ledger: { uncached: 1_200, cached: 40_000, written: 0, output: 350, reasoning: 200 },
    transport: () => chatTransport({
      prompt_tokens: 41_200, completion_tokens: 350, total_tokens: 41_550,
      prompt_tokens_details: { cached_tokens: 40_000 }, completion_tokens_details: { reasoning_tokens: 200 },
    }),
  },
  {
    name: 'Chat Completions on xAI: reasoning EXCLUDED from completion (billed as output)',
    model: 'grok-4.7',
    prompt: 41_200,
    ledger: { uncached: 1_200, cached: 40_000, written: 0, output: 350, reasoning: 200 },
    transport: () => chatTransport({
      prompt_tokens: 41_200, completion_tokens: 150, total_tokens: 41_550,
      prompt_tokens_details: { cached_tokens: 40_000 }, completion_tokens_details: { reasoning_tokens: 200 },
    }),
  },
  {
    name: 'Gemini Interactions: input INCLUDES cached; thoughts billed as output',
    model: 'gemini-3.8-flash',
    prompt: 41_200,
    ledger: { uncached: 1_200, cached: 40_000, written: 0, output: 350, reasoning: 200 },
    transport: () => interactionsTransport({
      total_input_tokens: 41_200, total_cached_tokens: 40_000, total_output_tokens: 150, total_thought_tokens: 200, total_tokens: 41_550,
    }),
  },
  {
    name: 'Gemini generateContent: promptTokenCount INCLUDES cachedContentTokenCount; thoughts billed as output',
    model: 'gemini-3.8-flash',
    prompt: 41_200,
    ledger: { uncached: 1_200, cached: 40_000, written: 0, output: 350, reasoning: 200 },
    transport: () => generateTransport({
      promptTokenCount: 41_200, cachedContentTokenCount: 40_000, candidatesTokenCount: 150, thoughtsTokenCount: 200,
    }),
  },
];

async function oneRound(lane: Lane, transport: Transport): Promise<Extract<HarnessEvent, { kind: 'usage' }>[]> {
  const taskId = `t-ledger-${Math.random().toString(36).slice(2)}`;
  const journal = new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `usage-ledger-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-02T00:00:00.000Z'),
  });
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools: [], onAuthHalt: async () => {} };
    },
  };
  const cfg = {
    onAttached: () => {},
    maxTurns: 3,
    transport,
    toolHost,
    journal,
    systemPrompt: 'You are a careful assistant.',
    runtimeConfig: { userId: 'user-1' },
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId, sessionId: taskId, cwd: '/tmp', model: lane.model, signal: new AbortController().signal, config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'Who is Priya?' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events.filter((e): e is Extract<HarnessEvent, { kind: 'usage' }> => e.kind === 'usage' && e.lane === undefined);
}

describe('C5: the ledger row is the provider\'s numbers, and the server\'s price is the runner\'s claim', () => {
  it.each(LANES.map((l) => [l.name, l] as const))('%s', async (_name, lane) => {
    const transport = lane.transport();
    const usageEvents = await oneRound(lane, transport);
    expect(usageEvents).toHaveLength(1);
    const usage = usageEvents[0].usage;
    const wire = toAgentUsageWire(usage);

    // 1. The row (task_turn_usage writes these wire fields verbatim) reads the provider's numbers.
    expect({
      uncached: wire.input_tokens,
      cached: wire.cache_read_input_tokens,
      written: wire.cache_creation_input_tokens,
      output: wire.output_tokens,
      reasoning: wire.reasoning_tokens,
    }).toEqual(lane.ledger);
    expect(wire.input_tokens_exclusive).toBe(true);

    // 2. Every prompt token lands in exactly one bucket.
    expect((wire.input_tokens ?? 0) + (wire.cache_read_input_tokens ?? 0) + (wire.cache_creation_input_tokens ?? 0)).toBe(lane.prompt);

    // 3. The server's CHARGE of the row is the runner's claimed cost, to the micro-dollar and beyond,
    //    with BILL_CACHE_WRITE_1H_V1 off and on: the 1-hour write price follows the flag on both sides.
    const tokens = tokenUsageFromWire(wire);
    expect(tokens).not.toBeNull();
    try {
      for (const flag of [undefined, 'true']) {
        if (flag) process.env.BILL_CACHE_WRITE_1H_V1 = flag;
        else delete process.env.BILL_CACHE_WRITE_1H_V1;
        const claimed = transport.computeCostUsd(usage, lane.model);
        const priced = priceUsageUsd(lane.model, chargeableTokenUsage(tokens!), { legacyInclusiveInput: wire.input_tokens_exclusive !== true, atMs: Date.now() });
        expect(priced).not.toBeNull();
        expect(claimed).toBeGreaterThan(0);
        expect(priced!.usd).toBeCloseTo(claimed, 12);
      }
    } finally {
      delete process.env.BILL_CACHE_WRITE_1H_V1;
    }
  });
});

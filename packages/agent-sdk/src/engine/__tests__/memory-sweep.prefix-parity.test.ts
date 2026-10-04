/**
 * SWEEP_PREFIX_PARITY_V1 — the memory sweep's request is the loop's LAST request plus one
 * trailing user message, on every wire format, or it reads none of the cache the turn wrote.
 *
 * Measured 2026-10-01 (task_turn_usage, cache_read / all input, main lane vs sweep):
 * gpt-6-luna 85 / 0, gpt-6.1-sol 83 / 13, deepseek-v4.1-flash 81 / 34, gemini-3.8-flash
 * 74 / 47, claude-opus-5-5 84 / 70. Direct provider probes the same day, each a warm call
 * with the loop's params then a sweep-shaped call on the same prefix, named the fields:
 *  - OpenAI Responses: no `prompt_cache_key` → 0% (vs 97%); `reasoning.effort` low → 0%.
 *  - Fireworks Chat Completions: no `x-session-affinity` → 0% (vs 96%); `reasoning_effort`
 *    low → 0%.
 *  - Gemini Interactions: `thinking_level` low → 0 cached where the loop's level hit.
 *  - Anthropic: `output_config.effort` low → 77% (vs 99%) with signed thinking in the
 *    last turn; the split system (CACHE_TIERING_V1) and the breakpoint markers do not
 *    move it. The output cap moves nothing on any of them.
 *
 * So the proof is at the WIRE, through the real transports: the engine runs a real turn
 * (a reasoning tool round, a reasoning final round, then the sweep) against each transport
 * with a capturing client, and the sweep's body must equal the loop's last body field for
 * field — instructions/system, tools, reasoning, include, store, cache keys, headers — with
 * the loop's history (its reasoning items, encrypted content, thought signatures,
 * reasoning_content, signed thinking) as an exact prefix of the sweep's. Only the output cap
 * and the trailing messages may differ.
 *
 * Flag OFF pins today's bytes, field by field, so the off path stays byte-identical and
 * the list documents exactly what the sweep used to get wrong per lane.
 *
 * NOT proven here: where Anthropic places its cache breakpoints on the sweep's longer history.
 * The Anthropic lanes strip the cache_control MARKERS before comparing (`markers`), so this
 * suite proves the content prefix is the loop's, not that a breakpoint sits where the
 * provider can read the loop's last write. Only a live drill's cache_read says that.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type Transport } from '../transport.js';
import { MEMORY_SWEEP_PROMPT, SWEEP_PARITY_MAX_TOKENS, runOffloopSweep } from '../memory-sweep.js';
import { loopRequestOf, type LoopRequest } from '../round-engine.js';
import { sweepCall } from '../post-turn-off-path.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { NativeConfig } from '../native-config.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';

const FLAG = 'SWEEP_PREFIX_PARITY_V1';
afterEach(() => {
  delete process.env[FLAG];
});

/** One request as it left for the provider: the body, and the headers sent with it. */
interface Wire {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** One lane's three provider responses, built fresh per run (a stream is read once): a tool round, a final round, the sweep. */
type Script = readonly [unknown, unknown, unknown];

interface Lane {
  name: string;
  model: string;
  /** The real transport, its client replaced by one that records each request and plays `script`. */
  transport(wires: Wire[]): Transport;
  /** The history field of this wire format. */
  history: 'messages' | 'input' | 'contents';
  /** Where this format keeps the output cap (dotted path). */
  cap: string;
  /** Strip breakpoint MARKERS from the history before comparing (Anthropic only: placement, not content). */
  markers?: boolean;
  /** A string the loop's history must carry, so the replay leg is really exercised. */
  replay: string;
  /** The sweep body's trailing message, as text. */
  trailing(body: Record<string, unknown>): string;
  /** Today's (flag-off) prefix differences, field by field: the defect, pinned. */
  legacy: string[];
}

// ── the capturing clients ─────────────────────────────────────────────────────

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const headersOf = (opts: unknown): Record<string, string> =>
  clone(((opts as { headers?: Record<string, string> } | undefined)?.headers) ?? {});

function scripted(script: Script): () => unknown {
  let i = 0;
  return () => {
    const next = script[i++];
    if (next === undefined) throw new Error('the lane asked for more model calls than the script holds');
    return next;
  };
}

function* responsesStream(output: Array<Record<string, unknown>>, text?: string) {
  for (const [i, item] of output.entries()) {
    if (item.type === 'reasoning') yield { type: 'response.output_item.added', output_index: i, item: { ...item } };
    if (item.type === 'function_call') {
      yield { type: 'response.output_item.added', output_index: i, item: { ...item, arguments: '' } };
    }
    if (item.type === 'message' && text) yield { type: 'response.output_text.delta', item_id: item.id, output_index: i, content_index: 0, delta: text };
    yield { type: 'response.output_item.done', output_index: i, item };
  }
  yield { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 400, output_tokens: 40 } } };
}
const asyncOf = <T>(it: Iterable<T>) =>
  (async function* () {
    yield* it;
  })();

function responsesTransport(wires: Wire[], script: Script): Transport {
  const next = scripted(script);
  const client = {
    baseURL: 'https://capture.invalid/v1',
    responses: {
      stream: (body: Record<string, unknown>, opts: unknown) => {
        wires.push({ body: clone(body), headers: headersOf(opts) });
        return next();
      },
    },
  } as unknown as OpenAI;
  return new OpenAIResponsesTransport({ client });
}

const REASONING_1 = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'find the note' }], encrypted_content: 'ENC-ONE' };
const REASONING_2 = { id: 'rs_2', type: 'reasoning', summary: [], encrypted_content: 'ENC-TWO' };
const CALL = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'search_notes', arguments: '{"q":"acme"}', status: 'completed' };
const ANSWER = 'Priya is your cofounder at Acme.';
const msg = (id: string, text: string) => ({
  id, type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const FACT = 'FACT [relationship] (user_direct) Priya is the cofounder of Acme.\n';

const RESPONSES_SCRIPT = (): Script => [
  asyncOf(responsesStream([REASONING_1, CALL])),
  asyncOf(responsesStream([REASONING_2, msg('msg_1', ANSWER)], ANSWER)),
  asyncOf(responsesStream([msg('msg_2', FACT)], FACT)),
];

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { choices: [{ index: 0, delta, ...extra }] };
}
const chatUsage = { choices: [], usage: { prompt_tokens: 400, completion_tokens: 40 } };
const CHAT_SCRIPT = (): Script => [
  asyncOf([
    chunk({ reasoning_content: 'I should search the notes.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"q":"acme"}' } }] }),
    chunk({}, { finish_reason: 'tool_calls' }),
    chatUsage,
  ]),
  asyncOf([chunk({ reasoning_content: 'Found it.' }), chunk({ content: ANSWER }), chunk({}, { finish_reason: 'stop' }), chatUsage]),
  asyncOf([chunk({ content: FACT }), chunk({}, { finish_reason: 'stop' }), chatUsage]),
];

function chatTransport(wires: Wire[], script: Script): Transport {
  const next = scripted(script);
  const client = {
    baseURL: 'https://capture.invalid/v1',
    chat: {
      completions: {
        stream: (body: Record<string, unknown>, opts: unknown) => {
          wires.push({ body: clone(body), headers: headersOf(opts) });
          return next();
        },
      },
    },
  } as unknown as OpenAI;
  return new ChatCompletionsTransport({ client });
}

function* thinkingBlock(index: number, thinking: string, signature: string) {
  yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } };
  yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } };
  yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } };
  yield { type: 'content_block_stop', index };
}
function* textBlock(index: number, text: string) {
  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } };
  yield { type: 'content_block_stop', index };
}
function* toolBlock(index: number) {
  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'tu_1', name: 'search_notes', input: {} } };
  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"q":"acme"}' } };
  yield { type: 'content_block_stop', index };
}
function anthropicStream(events: Iterable<unknown>, content: unknown[], stopReason: string) {
  const list = [...events];
  return {
    async *[Symbol.asyncIterator]() {
      yield* list;
    },
    async finalMessage() {
      return { stop_reason: stopReason, usage: { input_tokens: 400, output_tokens: 40 }, content };
    },
  };
}
const ANTHROPIC_SCRIPT = (): Script => [
  anthropicStream([...thinkingBlock(0, 'find the note', 'SIG-ONE'), ...toolBlock(1)], [
    { type: 'thinking', thinking: 'find the note', signature: 'SIG-ONE' },
    { type: 'tool_use', id: 'tu_1', name: 'search_notes', input: { q: 'acme' } },
  ], 'tool_use'),
  anthropicStream([...thinkingBlock(0, 'answer it', 'SIG-TWO'), ...textBlock(1, ANSWER)], [
    { type: 'thinking', thinking: 'answer it', signature: 'SIG-TWO' },
    { type: 'text', text: ANSWER },
  ], 'end_turn'),
  anthropicStream([...textBlock(0, FACT)], [{ type: 'text', text: FACT }], 'end_turn'),
];

function anthropicTransport(wires: Wire[], script: Script): Transport {
  const next = scripted(script);
  const client = {
    messages: {
      stream: (body: Record<string, unknown>, opts: unknown) => {
        wires.push({ body: clone(body), headers: headersOf(opts) });
        return next();
      },
    },
  };
  return new AnthropicMessagesTransport({ client: client as never });
}

const INTERACTIONS_SCRIPT = (): Script => [
  [
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'THOUGHT-SIG-ONE' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'fc_1', name: 'search_notes', arguments: {} } },
    { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: '{"q":"acme"}' } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'interaction.completed', interaction: { id: 'i1', status: 'requires_action', usage: { total_input_tokens: 400, total_output_tokens: 40 } } },
  ],
  [
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'THOUGHT-SIG-TWO' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text: ANSWER } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'interaction.completed', interaction: { id: 'i2', status: 'completed', usage: { total_input_tokens: 400, total_output_tokens: 40 } } },
  ],
  [
    { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
    { event_type: 'step.delta', index: 0, delta: { type: 'text', text: FACT } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'interaction.completed', interaction: { id: 'i3', status: 'completed', usage: { total_input_tokens: 400, total_output_tokens: 40 } } },
  ],
];

function interactionsTransport(wires: Wire[], script: Script): Transport {
  const next = scripted(script);
  return new GeminiInteractionsTransport({
    streamFactory: (body) => {
      wires.push({ body: clone(body) as unknown as Record<string, unknown>, headers: {} });
      return asyncOf(next() as unknown[]) as never;
    },
  });
}

const geminiUsage = { promptTokenCount: 400, candidatesTokenCount: 40 };
const GENERATE_SCRIPT = (): Script => [
  [{
    candidates: [{
      content: { role: 'model', parts: [
        { text: 'find the note', thought: true },
        { functionCall: { name: 'search_notes', args: { q: 'acme' } }, thoughtSignature: 'PART-SIG-ONE' },
      ] },
      finishReason: 'STOP',
    }],
    usageMetadata: geminiUsage,
  }],
  [{ candidates: [{ content: { role: 'model', parts: [{ text: ANSWER, thoughtSignature: 'PART-SIG-TWO' }] }, finishReason: 'STOP' }], usageMetadata: geminiUsage }],
  [{ candidates: [{ content: { role: 'model', parts: [{ text: FACT }] }, finishReason: 'STOP' }], usageMetadata: geminiUsage }],
];

function generateTransport(wires: Wire[], script: Script): Transport {
  const next = scripted(script);
  return new GeminiTransport({
    streamFactory: (_model, body) => {
      wires.push({ body: clone(body) as Record<string, unknown>, headers: {} });
      return asyncOf(next() as unknown[]) as never;
    },
  });
}

// ── the lanes ────────────────────────────────────────────────────────────────

const lastText = (items: unknown[]): string => JSON.stringify(items[items.length - 1]);

const LANES: Lane[] = [
  {
    name: 'OpenAI Responses (gpt-6.1-sol)',
    model: 'gpt-6.1-sol',
    transport: (w) => responsesTransport(w, RESPONSES_SCRIPT()),
    history: 'input', cap: 'max_output_tokens', replay: 'ENC-ONE',
    trailing: (b) => lastText(b.input as unknown[]),
    legacy: ['prompt_cache_key', 'reasoning.effort'],
  },
  {
    name: 'OpenAI Responses (gpt-6-luna, top effort)',
    model: 'gpt-6-luna',
    transport: (w) => responsesTransport(w, RESPONSES_SCRIPT()),
    history: 'input', cap: 'max_output_tokens', replay: 'ENC-ONE',
    trailing: (b) => lastText(b.input as unknown[]),
    legacy: ['prompt_cache_key', 'reasoning.effort'],
  },
  {
    name: 'Meta on the Responses transport (muse-spark-1.3)',
    model: 'muse-spark-1.3',
    transport: (w) => responsesTransport(w, RESPONSES_SCRIPT()),
    history: 'input', cap: 'max_output_tokens', replay: 'call_1',
    trailing: (b) => lastText(b.input as unknown[]),
    legacy: ['prompt_cache_key', 'reasoning.effort'],
  },
  {
    name: 'Fireworks Chat Completions (deepseek-v4.1-flash)',
    model: 'deepseek-v4.1-flash',
    transport: (w) => chatTransport(w, CHAT_SCRIPT()),
    history: 'messages', cap: 'max_tokens', replay: 'reasoning_content',
    trailing: (b) => lastText(b.messages as unknown[]),
    legacy: ['reasoning_effort', 'header:x-session-affinity'],
  },
  {
    name: 'xAI on the Chat Completions transport (grok-4.7)',
    model: 'grok-4.7',
    transport: (w) => chatTransport(w, CHAT_SCRIPT()),
    history: 'messages', cap: 'max_tokens', replay: 'call_1',
    trailing: (b) => lastText(b.messages as unknown[]),
    legacy: ['reasoning_effort'],
  },
  {
    name: 'Anthropic Messages (claude-sonnet-5-5, CACHE_TIERING_V1 split system)',
    model: 'claude-sonnet-5-5',
    transport: (w) => anthropicTransport(w, ANTHROPIC_SCRIPT()),
    history: 'messages', cap: 'max_tokens', markers: true, replay: 'SIG-ONE',
    trailing: (b) => lastText(b.messages as unknown[]),
    legacy: ['output_config.effort', 'system'],
  },
  {
    name: 'Anthropic Messages, budgeted thinking (claude-haiku-4-5)',
    model: 'claude-haiku-4-5',
    transport: (w) => anthropicTransport(w, ANTHROPIC_SCRIPT()),
    history: 'messages', cap: 'max_tokens', markers: true, replay: 'SIG-ONE',
    trailing: (b) => lastText(b.messages as unknown[]),
    legacy: ['system', 'thinking.budget_tokens'],
  },
  {
    name: 'Gemini Interactions (gemini-3.8-flash)',
    model: 'gemini-3.8-flash',
    transport: (w) => interactionsTransport(w, INTERACTIONS_SCRIPT()),
    history: 'input', cap: 'generation_config.max_output_tokens', replay: 'THOUGHT-SIG-ONE',
    trailing: (b) => lastText(b.input as unknown[]),
    legacy: ['generation_config.thinking_level'],
  },
  {
    name: 'Gemini generateContent (legacy dialect)',
    model: 'gemini-3.8-flash',
    transport: (w) => generateTransport(w, GENERATE_SCRIPT()),
    history: 'contents', cap: 'generationConfig.maxOutputTokens', replay: 'PART-SIG-ONE',
    trailing: (b) => lastText(b.contents as unknown[]),
    legacy: [],
  },
];

// ── the run ──────────────────────────────────────────────────────────────────

/** The fleet-static part of the system prompt, long enough for Anthropic to tier it. */
const FLEET = 'You are a careful assistant who keeps notes. '.repeat(260);
const SESSION = 'This session belongs to one person; their notes are private.';

const searchNotes: RawToolOptions = {
  name: 'search_notes',
  description: 'Search the notes for a phrase.',
  parameters: z.object({ q: z.string() }),
  execute: async () => 'Note 12: Priya, cofounder at Acme, prefers short updates.',
};

async function runTurn(lane: Lane): Promise<Wire[]> {
  const wires: Wire[] = [];
  const transport = lane.transport(wires);
  const taskId = `t-sweep-parity-${Math.random().toString(36).slice(2)}`;
  const journal = new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `sweep-parity-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-01T00:00:00.000Z'),
  });
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools: [searchNotes], onAuthHalt: async () => {} };
    },
  };
  const cfg = {
    onAttached: () => {},
    maxTurns: 6,
    transport,
    toolHost,
    journal,
    systemPrompt: FLEET + SESSION,
    systemFleetPrefixChars: FLEET.length,
    runtimeConfig: { userId: 'user-1' },
    namiOffloopSweep: true,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId,
    sessionId: 's-sweep-parity',
    cwd: '/tmp',
    model: lane.model,
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'Find my note about Acme and tell me who Priya is.' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  const end = events.find((e) => e.kind === 'turn_end') as Extract<HarnessEvent, { kind: 'turn_end' }> | undefined;
  expect(end?.outcome.kind, `${lane.name}: the turn completes`).toBe('completed');
  return wires;
}

// ── the comparison ───────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every leaf path where `a` and `b` differ (an array of another length is one path). */
function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [path || '(root)'];
    return a.flatMap((x, i) => diffPaths(x, b[i], `${path}[${i}]`));
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [path || '(root)'];
}

function take(body: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split('.');
  let at: Record<string, unknown> = body;
  for (const p of parts.slice(0, -1)) at = at[p] as Record<string, unknown>;
  const last = parts[parts.length - 1];
  const v = at[last];
  delete at[last];
  return v;
}

function stripMarkers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripMarkers);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'cache_control') out[k] = stripMarkers(x);
    return out;
  }
  return v;
}

/**
 * Where the sweep's request stops being the loop's last request plus a tail: every
 * differing field outside the history and the output cap, each header, and the history
 * itself when the loop's is not an exact prefix of the sweep's.
 */
function prefixDiff(lane: Lane, loop: Wire, sweep: Wire): string[] {
  const L = clone(loop.body);
  const S = clone(sweep.body);
  let lh = take(L, lane.history) as unknown[];
  let sh = take(S, lane.history) as unknown[];
  take(L, lane.cap);
  take(S, lane.cap);
  const out = diffPaths(L, S);
  if (lane.markers) {
    lh = stripMarkers(lh) as unknown[];
    sh = stripMarkers(sh) as unknown[];
  }
  const tail = sh.length > lh.length ? diffPaths(lh, sh.slice(0, lh.length), lane.history) : [`${lane.history}.length`];
  out.push(...tail);
  out.push(...diffPaths(loop.headers, sweep.headers).map((p) => `header:${p}`));
  return out;
}

// ── the tests ────────────────────────────────────────────────────────────────

describe('SWEEP_PREFIX_PARITY_V1 on: the sweep rides the loop request, on every wire', () => {
  it.each(LANES.map((l) => [l.name, l] as const))('%s', async (_name, lane) => {
    process.env[FLAG] = 'true';
    const wires = await runTurn(lane);
    // Two loop rounds, then the sweep (no suggestion, no compaction in this run).
    expect(wires).toHaveLength(3);
    const [, loop, sweep] = wires;
    // The fixture really carries the replay this lane must keep in its prefix.
    expect(JSON.stringify(loop.body[lane.history]), 'the loop history carries the replay').toContain(lane.replay);

    expect(prefixDiff(lane, loop, sweep)).toEqual([]);
    // Only its own tail and its own cap differ.
    expect(lane.trailing(sweep.body)).toContain(MEMORY_SWEEP_PROMPT.slice(0, 60));
    const cap = lane.cap.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], sweep.body);
    expect(cap).toBe(SWEEP_PARITY_MAX_TOKENS);
  });
});

describe('SWEEP_PREFIX_PARITY_V1 off: today\'s sweep, byte for byte (the defect, per lane)', () => {
  it.each(LANES.map((l) => [l.name, l] as const))('%s', async (_name, lane) => {
    const wires = await runTurn(lane);
    expect(wires).toHaveLength(3);
    const [, loop, sweep] = wires;
    expect(prefixDiff(lane, loop, sweep)).toEqual(lane.legacy);
    const cap = lane.cap.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], sweep.body);
    expect(cap).toBe(2048);
  });
});

// ── the seams behind it ──────────────────────────────────────────────────────

/** Records every callModel param object whole. */
class ParamsTransport extends FakeTransport {
  params: Array<Parameters<FakeTransport['callModel']>[0]> = [];
  constructor() {
    super([{ kind: 'text', text: FACT }, { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 40 } }]);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]) {
    this.params.push(p);
    return super.callModel(p);
  }
}

async function oneEntryJournal(): Promise<Journal> {
  const taskId = `t-sweep-seam-${Math.random().toString(36).slice(2)}`;
  const journal = new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `sweep-seam-${process.pid}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-01T00:00:00.000Z'),
  });
  await journal.append({
    taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', timestamp: '',
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text: 'Priya runs Acme with me.' }] },
  });
  return journal;
}

const LOOP_REQUEST: LoopRequest = {
  model: 'gpt-6.1-sol',
  system: 'the loop system',
  tools: [{ name: 'search_notes' }],
  cacheKey: 'u-0123456789abcdef',
  systemFleetPrefixChars: 4,
  cachePrefixHint: { summaryLeading: true },
};

describe('the loop request the sweep rides', () => {
  it('loopRequestOf drops only the history, the output cap and the signal (by rest, never a list)', () => {
    const signal = new AbortController().signal;
    const withAll = { ...LOOP_REQUEST, history: ['h'], maxTokens: 128_000, signal, aFieldTheLoopLearnsLater: 1 };
    expect(loopRequestOf(withAll as never)).toEqual({ ...LOOP_REQUEST, aFieldTheLoopLearnsLater: 1 });
  });

  it('sends the loop request verbatim with its own cap and history, no reasoning floor, and meters on its model', async () => {
    const transport = new ParamsTransport();
    const result = await runOffloopSweep({
      transport, journal: await oneEntryJournal(), elision: null,
      model: 'some-other-model', system: 'not read', providerTools: [],
      loopRequest: LOOP_REQUEST,
    });
    expect(transport.params).toHaveLength(1);
    const { history, signal, ...sent } = transport.params[0];
    expect(sent).toEqual({ ...LOOP_REQUEST, maxTokens: SWEEP_PARITY_MAX_TOKENS });
    expect('reasoningEffort' in transport.params[0]).toBe(false);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(history)).toContain(MEMORY_SWEEP_PROMPT.slice(0, 60));
    expect(result.model).toBe('gpt-6.1-sol');
    expect(result.status).toBe('ok');
  });

  it("flag on with no main request recorded: today's request, unchanged", async () => {
    process.env[FLAG] = 'true';
    const transport = new ParamsTransport();
    await sweepCall({
      cfg: { journal: await oneEntryJournal(), namiOffloopSweep: true } as unknown as NativeConfig,
      taskId: 't', model: 'gpt-6.1-sol', transport, system: 'S', wireTools: () => [], elision: null,
      loopRequest: null, loopInput: null, signal: new AbortController().signal, turnNumber: 1, clean: true,
      userTurn: { text: 'Priya runs Acme with me.' },
    }, new AbortController().signal);
    expect(transport.params).toHaveLength(1);
    expect(transport.params[0]).toMatchObject({ model: 'gpt-6.1-sol', system: 'S', maxTokens: 2048, reasoningEffort: 'low' });
    expect(transport.params[0].cacheKey).toBeUndefined();
  });

  it('flag off with a main request recorded: the request is ignored, byte-identical to today', async () => {
    const transport = new ParamsTransport();
    await sweepCall({
      cfg: { journal: await oneEntryJournal(), namiOffloopSweep: true } as unknown as NativeConfig,
      taskId: 't', model: 'gpt-6.1-sol', transport, system: 'S', wireTools: () => [], elision: null,
      loopRequest: LOOP_REQUEST, loopInput: null, signal: new AbortController().signal, turnNumber: 1, clean: true,
      userTurn: { text: 'Priya runs Acme with me.' },
    }, new AbortController().signal);
    expect(transport.params[0]).toMatchObject({ system: 'S', maxTokens: 2048, reasoningEffort: 'low' });
    expect(transport.params[0].cacheKey).toBeUndefined();
  });

  it('POST_TURN_OFF_PATH_V1: the sweep the idle lane runs rides the loop request too', async () => {
    process.env[FLAG] = 'true';
    process.env.POST_TURN_OFF_PATH_V1 = 'true';
    try {
      const lane = LANES[0];
      const wires = await runTurn(lane);
      expect(wires).toHaveLength(3);
      expect(prefixDiff(lane, wires[1], wires[2])).toEqual([]);
    } finally {
      delete process.env.POST_TURN_OFF_PATH_V1;
    }
  });
});

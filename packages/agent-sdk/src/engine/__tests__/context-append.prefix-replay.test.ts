/**
 * CONTEXT_APPEND_V1 (harness to nine C1) — the prefix is never rewritten mid-session, proven at
 * the WIRE on all five formats.
 *
 * One session, two runs through the real transports with a capturing client: run 1 is a tool
 * round and a final round; then the run ends (a box that slept, a continuation, a re-drive) and
 * run 2 opens on the same journal with ONE layer that now reads differently (the memory block),
 * exactly what the product hands the engine after a debounced Nami push. The contract: run 2's
 * first request equals run 1's last request plus an appended tail, field by field (system, tools,
 * reasoning, cache keys, headers), with the change carried IN that tail.
 *
 * Flag OFF pins the defect: the run boundary rewrites the system prompt, so the request is no
 * longer the previous one plus a tail and every byte of history behind it misses the cache.
 *
 * Revert-proof: undo the run-open hold (native-run-open.ts holdSessionPrefix) and the ON suite
 * fails on every lane, because run 2's system carries the new memory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { NativeHarness } from '../native-harness.js';
import type { Transport } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { assembleInstructionStack, type InstructionLayer } from '../../contract/instruction-stack.js';
import { effortText } from '../context-append.js';
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

const FLAG = 'CONTEXT_APPEND_V1';
/** The wire's own effort knobs (thinking-support.ts), set between the runs by the C7 cases. */
const EFFORT_ENVS = ['OPENAI_REASONING_EFFORT', 'GEMINI_THINKING_LEVEL'];
afterEach(() => {
  delete process.env[FLAG];
  for (const k of EFFORT_ENVS) delete process.env[k];
});

interface Wire {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** The session's three provider responses, in order: run 1's tool round and final round, run 2's round. */
type Script = readonly [unknown, unknown, unknown];
type Next = () => unknown;

interface Lane {
  name: string;
  model: string;
  /** A fresh real transport per run (as the product builds one), sharing the recorder and the script. */
  transport(wires: Wire[], next: Next): Transport;
  script(): Script;
  history: 'messages' | 'input' | 'contents';
  cap: string;
  markers?: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const headersOf = (opts: unknown): Record<string, string> =>
  clone(((opts as { headers?: Record<string, string> } | undefined)?.headers) ?? {});
const asyncOf = <T>(it: Iterable<T>) =>
  (async function* () {
    yield* it;
  })();

function scripted(script: Script): Next {
  let i = 0;
  return () => {
    const next = script[i++];
    if (next === undefined) throw new Error('the session asked for more model calls than the script holds');
    return next;
  };
}

const ANSWER = 'Priya is your cofounder at Acme.';
const ANSWER_2 = 'Here is a short update for Priya.';

// ── OpenAI Responses ─────────────────────────────────────────────────────────

function* responsesStream(output: Array<Record<string, unknown>>, text?: string) {
  for (const [i, item] of output.entries()) {
    if (item.type === 'reasoning') yield { type: 'response.output_item.added', output_index: i, item: { ...item } };
    if (item.type === 'function_call') yield { type: 'response.output_item.added', output_index: i, item: { ...item, arguments: '' } };
    if (item.type === 'message' && text) yield { type: 'response.output_text.delta', item_id: item.id, output_index: i, content_index: 0, delta: text };
    yield { type: 'response.output_item.done', output_index: i, item };
  }
  yield { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 400, output_tokens: 40 } } };
}
const reasoning = (id: string, enc: string) => ({ id, type: 'reasoning', summary: [], encrypted_content: enc });
const message = (id: string, text: string) => ({
  id, type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const CALL = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'search_notes', arguments: '{"q":"acme"}', status: 'completed' };

function responsesTransport(wires: Wire[], next: Next): Transport {
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

// ── Chat Completions ─────────────────────────────────────────────────────────

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ choices: [{ index: 0, delta, ...extra }] });
const chatUsage = { choices: [], usage: { prompt_tokens: 400, completion_tokens: 40 } };
const chatFinal = (thought: string, text: string) =>
  asyncOf([chunk({ reasoning_content: thought }), chunk({ content: text }), chunk({}, { finish_reason: 'stop' }), chatUsage]);

function chatTransport(wires: Wire[], next: Next): Transport {
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

// ── Anthropic Messages ───────────────────────────────────────────────────────

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
const anthropicFinal = (thought: string, sig: string, text: string) =>
  anthropicStream([...thinkingBlock(0, thought, sig), ...textBlock(1, text)], [
    { type: 'thinking', thinking: thought, signature: sig },
    { type: 'text', text },
  ], 'end_turn');

function anthropicTransport(wires: Wire[], next: Next): Transport {
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

// ── Gemini Interactions ──────────────────────────────────────────────────────

const interactionsFinal = (id: string, sig: string, text: string) => [
  { event_type: 'step.start', index: 0, step: { type: 'thought' } },
  { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: sig } },
  { event_type: 'step.stop', index: 0 },
  { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
  { event_type: 'step.delta', index: 1, delta: { type: 'text', text } },
  { event_type: 'step.stop', index: 1 },
  { event_type: 'interaction.completed', interaction: { id, status: 'completed', usage: { total_input_tokens: 400, total_output_tokens: 40 } } },
];

function interactionsTransport(wires: Wire[], next: Next): Transport {
  return new GeminiInteractionsTransport({
    streamFactory: (body) => {
      wires.push({ body: clone(body) as unknown as Record<string, unknown>, headers: {} });
      return asyncOf(next() as unknown[]) as never;
    },
  });
}

// ── Gemini generateContent ───────────────────────────────────────────────────

const geminiUsage = { promptTokenCount: 400, candidatesTokenCount: 40 };
const generateFinal = (text: string, sig: string) => [
  { candidates: [{ content: { role: 'model', parts: [{ text, thoughtSignature: sig }] }, finishReason: 'STOP' }], usageMetadata: geminiUsage },
];

function generateTransport(wires: Wire[], next: Next): Transport {
  return new GeminiTransport({
    streamFactory: (_model, body) => {
      wires.push({ body: clone(body) as Record<string, unknown>, headers: {} });
      return asyncOf(next() as unknown[]) as never;
    },
  });
}

// ── the lanes ────────────────────────────────────────────────────────────────

const LANES: Lane[] = [
  {
    name: 'OpenAI Responses (gpt-6.1-sol)',
    model: 'gpt-6.1-sol',
    transport: responsesTransport,
    script: () => [
      asyncOf(responsesStream([reasoning('rs_1', 'ENC-ONE'), CALL])),
      asyncOf(responsesStream([reasoning('rs_2', 'ENC-TWO'), message('msg_1', ANSWER)], ANSWER)),
      asyncOf(responsesStream([reasoning('rs_3', 'ENC-THREE'), message('msg_2', ANSWER_2)], ANSWER_2)),
    ],
    history: 'input', cap: 'max_output_tokens',
  },
  {
    name: 'Chat Completions (deepseek-v4.1-flash)',
    model: 'deepseek-v4.1-flash',
    transport: chatTransport,
    script: () => [
      asyncOf([
        chunk({ reasoning_content: 'I should search the notes.' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"q":"acme"}' } }] }),
        chunk({}, { finish_reason: 'tool_calls' }),
        chatUsage,
      ]),
      chatFinal('Found it.', ANSWER),
      chatFinal('Keep it short.', ANSWER_2),
    ],
    history: 'messages', cap: 'max_tokens',
  },
  {
    name: 'Anthropic Messages (claude-sonnet-5-5, CACHE_TIERING_V1 split system)',
    model: 'claude-sonnet-5-5',
    transport: anthropicTransport,
    script: () => [
      anthropicStream([...thinkingBlock(0, 'find the note', 'SIG-ONE'), ...toolBlock(1)], [
        { type: 'thinking', thinking: 'find the note', signature: 'SIG-ONE' },
        { type: 'tool_use', id: 'tu_1', name: 'search_notes', input: { q: 'acme' } },
      ], 'tool_use'),
      anthropicFinal('answer it', 'SIG-TWO', ANSWER),
      anthropicFinal('draft it', 'SIG-THREE', ANSWER_2),
    ],
    history: 'messages', cap: 'max_tokens', markers: true,
  },
  {
    name: 'Gemini Interactions (gemini-3.8-flash)',
    model: 'gemini-3.8-flash',
    transport: interactionsTransport,
    script: () => [
      [
        { event_type: 'step.start', index: 0, step: { type: 'thought' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'THOUGHT-SIG-ONE' } },
        { event_type: 'step.stop', index: 0 },
        { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'fc_1', name: 'search_notes', arguments: {} } },
        { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: '{"q":"acme"}' } },
        { event_type: 'step.stop', index: 1 },
        { event_type: 'interaction.completed', interaction: { id: 'i1', status: 'requires_action', usage: { total_input_tokens: 400, total_output_tokens: 40 } } },
      ],
      interactionsFinal('i2', 'THOUGHT-SIG-TWO', ANSWER),
      interactionsFinal('i3', 'THOUGHT-SIG-THREE', ANSWER_2),
    ],
    history: 'input', cap: 'generation_config.max_output_tokens',
  },
  {
    name: 'Gemini generateContent (legacy dialect)',
    model: 'gemini-3.8-flash',
    transport: generateTransport,
    script: () => [
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
      generateFinal(ANSWER, 'PART-SIG-TWO'),
      generateFinal(ANSWER_2, 'PART-SIG-THREE'),
    ],
    history: 'contents', cap: 'generationConfig.maxOutputTokens',
  },
];

// ── the session ──────────────────────────────────────────────────────────────

/** The fleet-static soul, long enough for Anthropic to tier it. */
const FLEET = 'You are a careful assistant who keeps notes. '.repeat(260).trim();
const NAMI_A = '<user_memory>\nPrefers short updates. Works with Priya at Acme.\n</user_memory>';
const NAMI_B = '<user_memory>\nPrefers short updates. Works with Priya at Acme. Moved to Lisbon in September.\n</user_memory>';

/** The fleet soul, the memory block, and (C7) a per-model tool index layer when given. */
const layersWith = (nami: string, tools?: string): InstructionLayer[] => [
  { id: 'soul', text: FLEET, static: true },
  ...(tools !== undefined ? [{ id: 'tool_search' as const, text: tools, static: true }] : []),
  { id: 'nami', text: nami, static: false },
];

const searchNotes: RawToolOptions = {
  name: 'search_notes',
  description: 'Search the notes for a phrase.',
  parameters: z.object({ q: z.string() }),
  execute: async () => 'Note 12: Priya, cofounder at Acme, prefers short updates.',
};

async function runOnce(lane: Lane, model: string, transport: Transport, journal: Journal, taskId: string, nami: string, text: string, tools?: string): Promise<void> {
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools: [searchNotes], onAuthHalt: async () => {} };
    },
  };
  const layers = layersWith(nami, tools);
  const cfg = {
    onAttached: () => {},
    maxTurns: 6,
    transport,
    toolHost,
    journal,
    systemPrompt: assembleInstructionStack(layers, 'native'),
    systemFleetPrefixChars: FLEET.length,
    instructionLayers: layers,
    runtimeConfig: { userId: 'user-1' },
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId, sessionId: taskId, cwd: '/tmp', model, signal: new AbortController().signal, config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  const end = events.find((e) => e.kind === 'turn_end') as Extract<HarnessEvent, { kind: 'turn_end' }> | undefined;
  expect(end?.outcome.kind, `${lane.name}: the turn completes`).toBe('completed');
}

/**
 * Two runs of one session: the second opens after the memory layer moved from `first` to
 * `second`, and (C7) on `next.model` and with `next.env` set when given: a setting changed.
 */
async function session(lane: Lane, first: string, second: string, next: { model?: string; env?: Record<string, string>; tools?: readonly [string, string] } = {}): Promise<Wire[]> {
  const wires: Wire[] = [];
  const step = scripted(lane.script());
  const taskId = `t-context-append-${Math.random().toString(36).slice(2)}`;
  const journal = new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `context-append-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-02T00:00:00.000Z'),
  });
  await runOnce(lane, lane.model, lane.transport(wires, step), journal, taskId, first, 'Find my note about Acme and tell me who Priya is.', next.tools?.[0]);
  Object.assign(process.env, next.env ?? {});
  await runOnce(lane, next.model ?? lane.model, lane.transport(wires, step), journal, taskId, second, 'Thanks. Draft a short update to her.', next.tools?.[1]);
  return wires;
}

// ── the comparison (as in memory-sweep.prefix-parity.test.ts) ────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

/** Where `next` stops being `prev` plus an appended tail: every differing field and header, and the history when `prev`'s is not an exact prefix. */
function prefixDiff(lane: Lane, prev: Wire, next: Wire): string[] {
  const P = clone(prev.body);
  const N = clone(next.body);
  let ph = take(P, lane.history) as unknown[];
  let nh = take(N, lane.history) as unknown[];
  take(P, lane.cap);
  take(N, lane.cap);
  const out = diffPaths(P, N);
  if (lane.markers) {
    ph = stripMarkers(ph) as unknown[];
    nh = stripMarkers(nh) as unknown[];
  }
  out.push(...(nh.length > ph.length ? diffPaths(ph, nh.slice(0, ph.length), lane.history) : [`${lane.history}.length`]));
  out.push(...diffPaths(prev.headers, next.headers).map((p) => `header:${p}`));
  return out;
}

// ── the tests ────────────────────────────────────────────────────────────────

describe('CONTEXT_APPEND_V1 on: a run boundary appends what changed and keeps the prefix', () => {
  it.each(LANES.map((l) => [l.name, l] as const))('%s', async (_name, lane) => {
    process.env[FLAG] = 'true';
    const wires = await session(lane, NAMI_A, NAMI_B);
    expect(wires).toHaveLength(3);
    const [, lastOfRun1, firstOfRun2] = wires;
    // Request N+1 is request N plus a tail: system, tools, every other field and header equal.
    expect(prefixDiff(lane, lastOfRun1, firstOfRun2)).toEqual([]);
    // The change rides that tail, and the system prompt still carries the session's first memory.
    const run2 = JSON.stringify(firstOfRun2.body);
    expect(JSON.stringify(firstOfRun2.body[lane.history])).toContain('<context_update>');
    expect(JSON.stringify(firstOfRun2.body[lane.history])).toContain('Moved to Lisbon in September.');
    expect(run2).toContain('Works with Priya at Acme.\\n</user_memory>');
  });
});

describe('CONTEXT_APPEND_V1 on: nothing changed, nothing is appended', () => {
  it.each(LANES.map((l) => [l.name, l] as const))('%s', async (_name, lane) => {
    process.env[FLAG] = 'true';
    const wires = await session(lane, NAMI_A, NAMI_A);
    expect(wires).toHaveLength(3);
    expect(prefixDiff(lane, wires[1], wires[2])).toEqual([]);
    expect(JSON.stringify(wires[2].body)).not.toContain('<context_update>');
  });
});

describe('CONTEXT_APPEND_V1 off: the run boundary rewrites the system prompt (the defect, pinned)', () => {
  it.each(LANES.map((l) => [l.name, l] as const))('%s', async (_name, lane) => {
    const wires = await session(lane, NAMI_A, NAMI_B);
    expect(wires).toHaveLength(3);
    expect(prefixDiff(lane, wires[1], wires[2]).length).toBeGreaterThan(0);
    const run2 = JSON.stringify(wires[2].body);
    expect(run2).toContain('Moved to Lisbon in September.');
    expect(run2).not.toContain('<context_update>');
    expect(run2).not.toContain('Works with Priya at Acme.\\n</user_memory>');
  });
});

// ── C7: an effort change is appended; a model change serves a fresh prompt ──

const laneNamed = (prefix: string): Lane => {
  const lane = LANES.find((l) => l.name.startsWith(prefix));
  if (!lane) throw new Error(`no lane ${prefix}`);
  return lane;
};
const historyOf = (lane: Lane, w: Wire) => JSON.stringify(w.body[lane.history]);

/** The two lanes whose effort has a knob today (the env overrides their resolvers read), and where it lands. */
const EFFORT_CASES = [
  { lane: laneNamed('OpenAI Responses'), env: { OPENAI_REASONING_EFFORT: 'high' }, path: 'reasoning.effort' },
  { lane: laneNamed('Gemini Interactions'), env: { GEMINI_THINKING_LEVEL: 'high' }, path: 'generation_config.thinking_level' },
] as const;

describe('C7 on: an effort change keeps every byte of the prefix and is told in the tail', () => {
  it.each(EFFORT_CASES.map((c) => [c.lane.name, c] as const))('%s', async (_name, c) => {
    process.env[FLAG] = 'true';
    const wires = await session(c.lane, NAMI_A, NAMI_A, { env: { ...c.env } });
    expect(wires).toHaveLength(3);
    // The ONLY difference outside the appended tail is the effort itself.
    expect(prefixDiff(c.lane, wires[1], wires[2])).toEqual([c.path]);
    expect(historyOf(c.lane, wires[2])).toContain('<part name=\\"reasoning effort\\">');
    expect(historyOf(c.lane, wires[2])).toContain(effortText('high'));
  });
});

describe('C7 off: the effort change is never told', () => {
  it.each(EFFORT_CASES.map((c) => [c.lane.name, c] as const))('%s', async (_name, c) => {
    const wires = await session(c.lane, NAMI_A, NAMI_A, { env: { ...c.env } });
    expect(prefixDiff(c.lane, wires[1], wires[2])).toEqual([c.path]);
    expect(historyOf(c.lane, wires[2])).not.toContain('reasoning effort');
  });
});

/** A second model on the same wire, that wire's system field, and where it carries the effort. */
const MODEL_CASES = [
  { lane: laneNamed('OpenAI Responses'), model: 'gpt-6-luna', system: 'instructions', effort: 'reasoning.effort' },
  { lane: laneNamed('Chat Completions'), model: 'glm-5.2', system: 'messages', effort: 'reasoning_effort' },
  { lane: laneNamed('Anthropic Messages'), model: 'claude-opus-5-5', system: 'system', effort: 'output_config.effort' },
] as const;

const at = (body: Record<string, unknown>, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], body);

const TOOLS_A = 'Tools you can load (the first model): notes_export.';
const TOOLS_B = 'Tools you can load (the picked model): notes_export, notes_share.';

describe('C7 on: a model change serves the NEW model\'s prompt, nothing appended', () => {
  it.each(MODEL_CASES.map((c) => [`${c.lane.name} -> ${c.model}`, c] as const))('%s', async (_name, c) => {
    process.env[FLAG] = 'true';
    // The product renders the tool index per model: run 2 is built for the picked one.
    const wires = await session(c.lane, NAMI_A, NAMI_A, { model: c.model, tools: [TOOLS_A, TOOLS_B] });
    expect(wires).toHaveLength(3);
    const system = JSON.stringify(wires[2].body[c.system]);
    // Fresh, not held: the picked model's index is in its system prompt, the old one is gone,
    // and no context update argues with it.
    expect(system).toContain(TOOLS_B);
    expect(system).not.toContain(TOOLS_A);
    expect(historyOf(c.lane, wires[2])).not.toContain('<context_update>');
    expect(wires[2].body.tools).toEqual(wires[1].body.tools);
    // The request really moved (the wire may spell the id its own way: Fireworks paths), and
    // carries the effort Transport.reasoningEffort resolves with the request's own function.
    expect(wires[2].body.model).not.toEqual(wires[1].body.model);
    const effort = c.lane.transport([], () => undefined).reasoningEffort?.(c.model);
    expect(effort).toBeDefined();
    expect(at(wires[2].body, c.effort)).toBe(effort);
  });
});

/**
 * L1 (TOOLS_MIDSTREAM_V1) — every transport says when one tool call is ready.
 *
 * For each of the five wire formats, a two-call stream is fed through the real transport's
 * readStream from a provider stream that logs every raw event it hands over. With the flag
 * on, `tool_ready` for the first call must arrive BEFORE the transport pulls the raw event
 * after the one that closed it (the moment, not the end of the stream); its id and input
 * must be the ones the call's `tool_use` carries after the stream. A call whose arguments
 * were torn is still reported, with input undefined (so an unreadable exclusive call can shut
 * the early starts' door), and calls are reported in call order. With the flag off the events
 * are exactly the flag-on events minus every `tool_ready` (the stream every other consumer
 * sees is unchanged).
 *
 * Revert proof: drop any transport's emission (or its accumulator's takeReady) and its
 * 'ready the moment' case fails on the missing event.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { StreamEvent } from '../../engine/transport.js';
import { readyToolArgs } from '../../engine/tool-ready.js';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { GeminiTransport } from '../gemini-transport.js';
import { GeminiInteractionsTransport } from '../gemini-interactions-transport.js';

const FLAG = 'TOOLS_MIDSTREAM_V1';
afterEach(() => {
  delete process.env[FLAG];
});

/** A provider stream that logs `pull:<i>` as it hands over raw event i. */
function logged<T>(items: T[], log: string[]): AsyncIterable<T> {
  return (async function* () {
    for (let i = 0; i < items.length; i++) {
      log.push(`pull:${i}`);
      yield items[i];
    }
  })();
}

/** Drain a transport's events, logging `ready:<id>` the moment each tool_ready arrives. */
async function drain(events: AsyncIterable<StreamEvent>, log: string[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) {
    if (e.kind === 'tool_ready') log.push(`ready:${e.toolUse.id}`);
    out.push(e);
  }
  return out;
}

type Lane = {
  name: string;
  /** The two-call stream; `torn` tears the second call's arguments. */
  items: (torn: boolean) => unknown[];
  read: (items: unknown[], log: string[]) => AsyncIterable<StreamEvent>;
  /** The raw event index that CLOSES call one / call two (ready lands right after its pull). */
  closesFirst: number;
  closesSecond: number;
  /** False where the wire's args are objects that cannot tear (Gemini generateContent). */
  canTear: boolean;
};

const anthropic: Lane = {
  name: 'Anthropic Messages',
  items: (torn) => [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"tag":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"one"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c2', name: 'Grep', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: torn ? '{"tag":"tw' : '{"tag":"two"}' } },
    { type: 'content_block_stop', index: 1 },
  ],
  read: (items, log) => {
    const client = {
      messages: {
        stream: () => ({
          [Symbol.asyncIterator]: () => logged(items, log)[Symbol.asyncIterator](),
          finalMessage: async () => ({ stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 } }),
        }),
      },
    };
    const t = new AnthropicMessagesTransport({ client: client as never });
    const stream = t.callModel({
      model: 'claude-opus-4-8', system: 'S', tools: [], history: [{ role: 'user', content: 'go' }], maxTokens: 8192,
    } as never);
    return t.readStream(stream);
  },
  closesFirst: 3,
  closesSecond: 6,
  canTear: true,
};

const responses: Lane = {
  name: 'OpenAI Responses',
  items: (torn) => {
    const second = torn ? '{"tag":"tw' : '{"tag":"two"}';
    return [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'Read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"tag":"one"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc1', output_index: 0, arguments: '{"tag":"one"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'Read', arguments: '{"tag":"one"}' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc2', call_id: 'c2', name: 'Grep', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc2', output_index: 1, delta: second },
      { type: 'response.function_call_arguments.done', item_id: 'fc2', output_index: 1, arguments: second },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc2', call_id: 'c2', name: 'Grep', arguments: second } },
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 3 } } },
    ];
  },
  read: (items, log) => new OpenAIResponsesTransport().readStream(logged(items, log)),
  closesFirst: 2,
  closesSecond: 6,
  canTear: true,
};

const chat: Lane = {
  name: 'Chat Completions',
  items: (torn) => [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"tag":"one"}' } }] } }] },
    // The natural boundary: the next index opening closes call one.
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'Grep', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: torn ? '{"tag":"tw' : '{"tag":"two"}' } }] } }] },
    // …and the choice finishing closes the rest.
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ],
  read: (items, log) => new ChatCompletionsTransport().readStream(logged(items, log)),
  closesFirst: 2,
  closesSecond: 4,
  canTear: true,
};

const gemini: Lane = {
  name: 'Gemini generateContent',
  items: () => [
    { candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { tag: 'one' } } }] } }] },
    { candidates: [{ content: { parts: [{ text: 'and also' }] } }] },
    {
      candidates: [{ content: { parts: [{ functionCall: { name: 'Grep', args: { tag: 'two' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    },
  ],
  read: (items, log) => new GeminiTransport().readStream(logged(items, log)),
  closesFirst: 0,
  closesSecond: 2,
  canTear: false,
};

const interactions: Lane = {
  name: 'Gemini Interactions',
  items: (torn) => [
    { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'c1', name: 'Read', arguments: {} } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"tag":"one"}' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'c2', name: 'Grep', arguments: {} } },
    { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: torn ? '{"tag":"tw' : '{"tag":"two"}' } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'interaction.completed', interaction: { id: 'i', status: 'requires_action', usage: { total_input_tokens: 5, total_output_tokens: 3 } } },
  ],
  read: (items, log) => new GeminiInteractionsTransport().readStream(logged(items, log)),
  closesFirst: 2,
  closesSecond: 5,
  canTear: true,
};

const LANES = [anthropic, responses, chat, gemini, interactions];

const readies = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { kind: 'tool_ready' }> => e.kind === 'tool_ready').map((e) => e.toolUse);
const uses = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { kind: 'tool_use' }> => e.kind === 'tool_use').map((e) => e.toolUse);
/** Gemini mints a fresh UUID per call per stream; two passes compare with the ids masked. */
const masked = (v: unknown) => JSON.stringify(v).replace(/gemini-call-[0-9a-f-]{36}/g, 'gemini-call-*');

describe.each(LANES)('tool_ready on $name', (lane) => {
  it('midstream: ready the moment a call closes, with the id and input its tool_use carries', async () => {
    process.env[FLAG] = 'true';
    const log: string[] = [];
    const events = await drain(lane.read(lane.items(false), log), log);
    const ready = readies(events);
    const used = uses(events);
    expect(ready.map((r) => r.name)).toEqual(['Read', 'Grep']);
    expect(ready.map((r) => r.input)).toEqual([{ tag: 'one' }, { tag: 'two' }]);
    // The same calls the stream names afterwards: same ids, same inputs, same order.
    expect(used.map((u) => ({ id: u.id, name: u.name, input: u.input }))).toEqual(ready);
    // The moment: right after the raw event that closed the call, before the next one.
    const first = log.indexOf(`ready:${ready[0].id}`);
    expect(first).toBeGreaterThan(log.indexOf(`pull:${lane.closesFirst}`));
    expect(first).toBeLessThan(log.indexOf(`pull:${lane.closesFirst + 1}`));
    const second = log.indexOf(`ready:${ready[1].id}`);
    expect(second).toBeGreaterThan(log.indexOf(`pull:${lane.closesSecond}`));
    // Every ready precedes the stream's tool_use and done events.
    const firstUse = events.findIndex((e) => e.kind === 'tool_use');
    expect(events.findIndex((e) => e.kind === 'tool_ready')).toBeLessThan(firstUse);
  });

  it('midstream off: no tool_ready, every other event unchanged', async () => {
    process.env[FLAG] = 'true';
    const on = await drain(lane.read(lane.items(false), []), []);
    delete process.env[FLAG];
    const off = await drain(lane.read(lane.items(false), []), []);
    expect(off.some((e) => e.kind === 'tool_ready')).toBe(false);
    expect(masked(off)).toBe(masked(on.filter((e) => e.kind !== 'tool_ready')));
  });

  it.runIf(lane.canTear)('midstream: a call whose arguments were torn is reported unreadable (input undefined), in order', async () => {
    process.env[FLAG] = 'true';
    const events = await drain(lane.read(lane.items(true), []), []);
    expect(readies(events).map((r) => [r.name, r.input])).toEqual([['Read', { tag: 'one' }], ['Grep', undefined]]);
    // The torn call still arrives as tool_use, degraded to {} exactly as before.
    expect(uses(events).map((u) => [u.name, u.input])).toEqual([['Read', { tag: 'one' }], ['Grep', {}]]);
  });
});

describe('tool_ready: Chat Completions closes a call only when it is done', () => {
  const chunk = (tc: Record<string, unknown>) => ({ choices: [{ index: 0, delta: { tool_calls: [tc] } }] });
  const FINISH = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
  const USAGE = { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } };

  it('midstream: a names-first provider (every name, then every argument) gets no premature ready', async () => {
    process.env[FLAG] = 'true';
    const log: string[] = [];
    const items = [
      chunk({ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '' } }),
      chunk({ index: 1, id: 'c2', type: 'function', function: { name: 'Grep', arguments: '' } }),
      chunk({ index: 0, function: { arguments: '{"tag":"one"}' } }),
      chunk({ index: 1, function: { arguments: '{"tag":"two"}' } }),
      FINISH,
      USAGE,
    ];
    const events = await drain(new ChatCompletionsTransport().readStream(logged(items, log)), log);
    // Index 1 opening did NOT close index 0: it had no arguments yet (a defaults run).
    expect(log.indexOf('ready:c1')).toBeGreaterThan(log.indexOf('pull:4'));
    expect(readies(events)).toEqual([
      { id: 'c1', name: 'Read', input: { tag: 'one' } },
      { id: 'c2', name: 'Grep', input: { tag: 'two' } },
    ]);
    expect(uses(events).map((u) => ({ id: u.id, name: u.name, input: u.input }))).toEqual(readies(events));
  });

  it("midstream: a call whose provider id arrives after the next index opens is reported under that id, never a minted one", async () => {
    process.env[FLAG] = 'true';
    const items = [
      chunk({ index: 0, type: 'function', function: { name: 'Read', arguments: '{"tag":"one"}' } }),
      chunk({ index: 1, id: 'c2', type: 'function', function: { name: 'Grep', arguments: '{"tag":"two"}' } }),
      chunk({ index: 0, id: 'c1' }),
      FINISH,
      USAGE,
    ];
    const events = await drain(new ChatCompletionsTransport().readStream(logged(items, [])), []);
    expect(readies(events).map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(uses(events).map((u) => u.id)).toEqual(['c1', 'c2']);
  });

  it('midstream: interleaved arguments: a later call never reports ahead of an earlier one still streaming', async () => {
    process.env[FLAG] = 'true';
    const log: string[] = [];
    const items = [
      chunk({ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"tag":' } }),
      chunk({ index: 1, id: 'c2', type: 'function', function: { name: 'Grep', arguments: '{"tag":"two"}' } }),
      chunk({ index: 2, id: 'c3', type: 'function', function: { name: 'Glob', arguments: '{"tag":"three"}' } }),
      chunk({ index: 0, function: { arguments: '"one"}' } }),
      FINISH,
      USAGE,
    ];
    const events = await drain(new ChatCompletionsTransport().readStream(logged(items, log)), log);
    // Index 0 was unfinished when 1 and 2 opened, so nothing was reported until the finish.
    expect(log.findIndex((l) => l.startsWith('ready:'))).toBeGreaterThan(log.indexOf('pull:4'));
    expect(readies(events).map((r) => [r.id, r.input])).toEqual([
      ['c1', { tag: 'one' }], ['c2', { tag: 'two' }], ['c3', { tag: 'three' }],
    ]);
  });
});

describe('tool_ready: Gemini Interactions reports calls in call order', () => {
  it('midstream: a later step stopping first waits for the earlier one', async () => {
    process.env[FLAG] = 'true';
    const log: string[] = [];
    const items = [
      { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'c1', name: 'Read', arguments: { tag: 'one' } } },
      { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'c2', name: 'Grep', arguments: { tag: 'two' } } },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'requires_action', usage: { total_input_tokens: 5, total_output_tokens: 3 } } },
    ];
    const events = await drain(new GeminiInteractionsTransport().readStream(logged(items, log)), log);
    expect(readies(events).map((r) => r.id)).toEqual(['c1', 'c2']);
    // Grep's stop (raw event 2) reported nothing; both came after Read's stop (raw event 3).
    expect(log.indexOf('ready:c2')).toBeGreaterThan(log.indexOf('pull:3'));
    expect(log.indexOf('ready:c1')).toBeGreaterThan(log.indexOf('pull:3'));
  });
});

describe('tool_ready: the readiness rule', () => {
  it('midstream: no arguments read as {}; an object is ready; anything else is not', () => {
    expect(readyToolArgs('')).toEqual({});
    expect(readyToolArgs('  ')).toEqual({});
    expect(readyToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(readyToolArgs('{"a":')).toBeUndefined();
    expect(readyToolArgs('[1,2]')).toBeUndefined();
    expect(readyToolArgs('"text"')).toBeUndefined();
    expect(readyToolArgs('null')).toBeUndefined();
  });

  it('midstream: an id-less Chat Completions call is ready under the id its tool_use carries', async () => {
    process.env[FLAG] = 'true';
    const items = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'Read', arguments: '{"tag":"one"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ];
    const events = await drain(new ChatCompletionsTransport().readStream(logged(items, [])), []);
    const [ready] = readies(events);
    expect(ready.id).toMatch(/^call_/);
    expect(uses(events).map((u) => u.id)).toEqual([ready.id]);
  });

  it('midstream: a Gemini Interactions call with no argument fragments is ready with its start arguments', async () => {
    process.env[FLAG] = 'true';
    const items = [
      { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'c1', name: 'Read', arguments: { tag: 'one' } } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'requires_action', usage: { total_input_tokens: 5, total_output_tokens: 3 } } },
    ];
    const events = await drain(new GeminiInteractionsTransport().readStream(logged(items, [])), []);
    expect(readies(events)).toEqual([{ id: 'c1', name: 'Read', input: { tag: 'one' } }]);
  });
});

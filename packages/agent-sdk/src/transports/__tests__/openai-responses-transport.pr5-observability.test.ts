import { describe, it, expect, vi, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { StreamEvent } from '../../engine/transport.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

// A HEAD reasoning item (precedes no function_call), then the answer message, then a
// completed response with no tool call (and no `output` — the output_item.done fallback).
function* headReasoningThenAnswerStream(): Generator<Ev> {
  yield {
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'rs_head', type: 'reasoning', summary: [], encrypted_content: 'EH', status: 'completed' },
  } as unknown as Ev;
  yield {
    type: 'response.output_item.done',
    output_index: 1,
    item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
  } as unknown as Ev;
  yield {
    type: 'response.completed',
    response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
  } as unknown as Ev;
}

// ─── Item 5 — no-journal pushAssistant orders head reasoning BEFORE the assistant
// message: the round's sealed output, in the provider's order (the journal projection
// replays the same channel).
describe('OpenAIResponsesTransport — PR5 item 5: no-journal head-reasoning ordering', () => {
  it('orders [head-reasoning, assistant-msg] as the provider sent them', async () => {
    const t = new OpenAIResponsesTransport({ client: {} as unknown as OpenAI });
    const events = await drain(t.readStream(headReasoningThenAnswerStream()));
    const done = events.find((e) => e.kind === 'done') as Extract<StreamEvent, { kind: 'done' }>;

    const history: OpenAI.Responses.ResponseInputItem[] = [];
    // An assistant turn that produced TEXT (the answer) and head reasoning, no tool call.
    const blocks: ContentBlock[] = [{ type: 'text', text: 'answer' }];
    t.pushAssistant(history, blocks, done.replay);

    const reasoningIdx = history.findIndex((i) => (i as { type?: string }).type === 'reasoning');
    const asstIdx = history.findIndex((i) => (i as { role?: string }).role === 'assistant');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    // Head reasoning must come BEFORE the assistant message (parity with the journal path).
    expect(reasoningIdx).toBeLessThan(asstIdx);
    expect(history[reasoningIdx]).toMatchObject({ type: 'reasoning', id: 'rs_head', encrypted_content: 'EH' });
    expect(history[asstIdx]).toMatchObject({ role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'answer' }] });
  });

  it('still emits no reasoning item and a bare assistant message when none was captured (byte-identical)', () => {
    const t = new OpenAIResponsesTransport({ client: {} as unknown as OpenAI });
    const history: OpenAI.Responses.ResponseInputItem[] = [];
    t.pushAssistant(history, [{ type: 'text', text: 'plain' }]);
    expect(history.some((i) => (i as { type?: string }).type === 'reasoning')).toBe(false);
    expect(history).toEqual([{ role: 'assistant', content: 'plain' }]);
  });
});

// ─── Item 3 — system-prefix mutation guard (parity with anthropic-transport).
describe('OpenAIResponsesTransport — PR5 item 3: system-prefix mutation guard', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeStreamClient(): OpenAI {
    // A minimal client whose responses.stream returns a never-iterated handle —
    // callModel only needs to invoke the guard before building the request; we
    // never drain the stream here.
    return {
      responses: {
        stream: () => ({ async *[Symbol.asyncIterator]() {} }),
      },
    } as unknown as OpenAI;
  }

  function call(t: OpenAIResponsesTransport, system: string): void {
    t.callModel({
      model: 'gpt-5.5',
      system,
      tools: [],
      history: [],
      maxTokens: 1024,
    });
  }

  it('does NOT warn when the system prefix is stable across calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    call(t, 'STABLE SYSTEM');
    call(t, 'STABLE SYSTEM');
    call(t, 'STABLE SYSTEM');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE with [CACHE_PROMPT_MUTATED] when the system prefix drifts on a later call', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    call(t, 'ORIGINAL');
    call(t, 'DRIFTED'); // first drift → exactly one warn
    call(t, 'DRIFTED'); // re-pinned → no further warn
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[CACHE_PROMPT_MUTATED]');
  });

  it('never throws (pure observation) — drift on the first call after pin is fine', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    expect(() => {
      call(t, 'A');
      call(t, 'B');
    }).not.toThrow();
  });
});

// ─── Item 4 — verbosity (safe knob) + gpt-5.5 default-effort bump.
describe('OpenAIResponsesTransport — PR5 item 4: verbosity + default-effort', () => {
  function transportWithSpy() {
    const stream = vi.fn().mockReturnValue(
      (async function* () {
        /* no events — only the request body is asserted */
      })(),
    );
    const client = { responses: { stream } } as unknown as OpenAI;
    return { transport: new OpenAIResponsesTransport({ client }), stream };
  }

  const BASE = {
    model: 'gpt-5.4',
    system: 'you are a helper',
    tools: [] as never[],
    history: [] as never[],
    maxTokens: 4096,
  };

  it('omits text entirely when neither outputFormat nor verbosity is set (byte-identical)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE });
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect('text' in body).toBe(false);
  });

  it('merges verbosity into the text object when set (no outputFormat → text = { verbosity })', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE, verbosity: 'low' });
    const body = stream.mock.calls[0][0] as { text?: Record<string, unknown> };
    expect(body.text).toEqual({ verbosity: 'low' });
  });

  it('merges verbosity alongside text.format when BOTH outputFormat and verbosity are set', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({
      ...BASE,
      verbosity: 'high',
      outputFormat: {
        type: 'json_schema',
        name: 'spec',
        schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } as never,
      },
    });
    const body = stream.mock.calls[0][0] as { text?: { format?: unknown; verbosity?: string } };
    expect(body.text?.verbosity).toBe('high');
    expect(body.text?.format).toMatchObject({ type: 'json_schema', strict: true, name: 'spec' });
  });

  it('resolves gpt-5.5 default reasoning effort to high (quality bump)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE, model: 'gpt-5.5' });
    const body = stream.mock.calls[0][0] as { reasoning?: { effort?: string } };
    expect(body.reasoning?.effort).toBe('high');
  });
});

// ─── Item 3 (2026-08-25) — the pin is scoped PER CACHE ROUTE ──────────────────
// One transport instance serves a whole run, and a run's off-loop side-calls
// (compaction / suggestion / vision) each carry their OWN system prompt while the
// main loop carries the task's. A single pinned slot read every switch between
// those lanes as drift — the 2026-08-24 burn log's [CACHE_PROMPT_MUTATED] warns
// were all that. The Responses arm already routes `cacheKey` to `prompt_cache_key`
// (its provider-side cache route), so the pin keys off the same value.
describe('OpenAIResponsesTransport — prefix guard scoped per cache route', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeStreamClient(): OpenAI {
    return {
      responses: {
        stream: () => ({ async *[Symbol.asyncIterator]() {} }),
      },
    } as unknown as OpenAI;
  }

  function call(t: OpenAIResponsesTransport, system: string, cacheKey?: string): void {
    t.callModel({
      model: 'gpt-5.5',
      system,
      tools: [],
      history: [],
      maxTokens: 1024,
      ...(cacheKey !== undefined && { cacheKey }),
    });
  }

  it('does NOT warn when two cache routes alternate on one shared instance', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    call(t, 'SYSTEM A', 'route-a');
    call(t, 'SYSTEM B', 'route-b');
    call(t, 'SYSTEM A', 'route-a');
    call(t, 'SYSTEM B', 'route-b');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when a keyless side-call interleaves with a keyed main route', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    call(t, 'MAIN SYSTEM', 'u-abc');
    call(t, 'COMPACTION SYSTEM');
    call(t, 'MAIN SYSTEM', 'u-abc');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns ONCE on real drift WITHIN one cache route, then re-pins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    call(t, 'ORIGINAL', 'route-a');
    call(t, 'OTHER LANE', 'route-b');
    call(t, 'DRIFTED', 'route-a');
    call(t, 'DRIFTED', 'route-a');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[CACHE_PROMPT_MUTATED]');
  });

  it('preserves the old single-slot behaviour for calls that carry NO cacheKey', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    call(t, 'ORIGINAL');
    call(t, 'DRIFTED');
    call(t, 'DRIFTED');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest route past the cap — an evicted route re-pins SILENTLY, live routes still warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new OpenAIResponsesTransport({ client: fakeStreamClient() });
    for (let i = 0; i <= 256; i++) call(t, `SYSTEM ${i}`, `route-${i}`);
    call(t, 'A WHOLLY DIFFERENT PREFIX', 'route-0');
    expect(warn).not.toHaveBeenCalled();
    call(t, 'DRIFTED', 'route-256');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

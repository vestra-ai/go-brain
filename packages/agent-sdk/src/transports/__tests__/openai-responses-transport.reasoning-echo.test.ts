import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { StreamEvent } from '../../engine/transport.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;

// A reasoning item, then a function_call, then completed.
function* reasoningThenToolStream(): Generator<Ev> {
  yield {
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC1', status: 'completed' },
  } as unknown as Ev;
  yield {
    type: 'response.output_item.done',
    output_index: 1,
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'do_it', arguments: '{"x":1}' },
  } as unknown as Ev;
  yield {
    type: 'response.completed',
    response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
  } as unknown as Ev;
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('OpenAIResponsesTransport — reasoning-item echo round-trip (§4.3a)', () => {
  it('captures the reasoning item during readStream and echoes it BEFORE its function_call in pushAssistant', async () => {
    const t = new OpenAIResponsesTransport({ client: {} as unknown as OpenAI });
    const events = await drain(t.readStream(reasoningThenToolStream()));
    // tool_use still surfaces
    expect(events.some((e) => e.kind === 'tool_use')).toBe(true);

    const history: OpenAI.Responses.ResponseInputItem[] = [];
    const blocks: ContentBlock[] = [
      { type: 'tool_use', toolUseId: 'call_1', toolName: 'do_it', toolInput: { x: 1 } } as unknown as ContentBlock,
    ];
    // The round's reasoning rides its own done event (the sealed output), not the instance.
    const done = events.find((e) => e.kind === 'done') as Extract<StreamEvent, { kind: 'done' }>;
    t.pushAssistant(history, blocks, done.replay);

    // reasoning item is echoed verbatim, positioned immediately before its function_call
    const reasoningIdx = history.findIndex((i) => (i as { type?: string }).type === 'reasoning');
    const fcIdx = history.findIndex((i) => (i as { type?: string }).type === 'function_call');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(fcIdx);
    expect(history[reasoningIdx]).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1' });
    expect(history[fcIdx]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
  });

  it('adds NO reasoning item when none was captured (non-reasoning turn byte-identical)', () => {
    const t = new OpenAIResponsesTransport({ client: {} as unknown as OpenAI });
    const history: OpenAI.Responses.ResponseInputItem[] = [];
    t.pushAssistant(history, [
      { type: 'tool_use', toolUseId: 'call_2', toolName: 'f', toolInput: {} } as unknown as ContentBlock,
    ]);
    expect(history.some((i) => (i as { type?: string }).type === 'reasoning')).toBe(false);
    expect(history).toEqual([{ type: 'function_call', call_id: 'call_2', name: 'f', arguments: '{}' }]);
  });
});

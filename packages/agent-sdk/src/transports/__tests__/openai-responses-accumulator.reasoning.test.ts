import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { createOpenAIResponsesAccumulator } from '../openai-responses-messages.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;

const done = (output_index: number, item: Record<string, unknown>): Ev =>
  ({ type: 'response.output_item.done', output_index, item }) as unknown as Ev;

describe('ResponsesAccumulator — the sealed output', () => {
  it('prefers the terminal response\'s own `output` over the streamed items', () => {
    const acc = createOpenAIResponsesAccumulator();
    acc.onEvent(done(0, { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'STREAMED' }));
    const final = [{ id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'FINAL' }];
    acc.onEvent({ type: 'response.completed', response: { status: 'completed', output: final, usage: {} } } as unknown as Ev);
    expect(acc.output()).toEqual(final);
  });

  it('falls back to the output_item.done items in output order, reasoning without encrypted_content included', () => {
    const acc = createOpenAIResponsesAccumulator();
    acc.onEvent(done(1, { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'do_it', arguments: '{}' }));
    acc.onEvent(done(0, { id: 'rs_2', type: 'reasoning', summary: [], status: 'completed' }));
    acc.onEvent({ type: 'response.completed', response: { status: 'completed', usage: {} } } as unknown as Ev);
    expect(acc.output()?.map((i) => i.id)).toEqual(['rs_2', 'fc_1']);
    expect(acc.toolUses().map((t) => t.id)).toEqual(['call_1']);
  });

  it('is undefined when the stream carried no item', () => {
    const acc = createOpenAIResponsesAccumulator();
    acc.onEvent({ type: 'response.completed', response: { status: 'completed', usage: {} } } as unknown as Ev);
    expect(acc.output()).toBeUndefined();
  });
});

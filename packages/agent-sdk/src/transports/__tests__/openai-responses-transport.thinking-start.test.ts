import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { StreamEvent } from '../../engine/transport.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;

/**
 * Arm parity with the Anthropic `thinking_start`: readStream must yield a
 * `thinking_start` StreamEvent the moment the reasoning output item is ADDED,
 * BEFORE the first reasoning-summary fragment — so the UI mounts the thinking pill
 * the instant reasoning begins. Non-reasoning turns never yield it.
 */

function reasoningAdded(id: string, idx: number): Ev {
  return {
    type: 'response.output_item.added',
    output_index: idx,
    item: { id, type: 'reasoning', summary: [] },
  } as unknown as Ev;
}
function summaryDelta(text: string): Ev {
  return { type: 'response.reasoning_summary_text.delta', delta: text } as unknown as Ev;
}
function completed(): Ev {
  return {
    type: 'response.completed',
    response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
  } as unknown as Ev;
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const client = {} as unknown as OpenAI;

describe('OpenAIResponsesTransport.readStream — thinking_start', () => {
  it('yields thinking_start when the reasoning item is added, BEFORE the first summary fragment', async () => {
    const t = new OpenAIResponsesTransport({ client });
    function* s(): Generator<Ev> {
      yield reasoningAdded('rs_1', 0);
      yield summaryDelta('Let me think.');
      yield completed();
    }
    const events = await drain(t.readStream(s()));
    const startIdx = events.findIndex((e) => e.kind === 'thinking_start');
    const firstThinkIdx = events.findIndex((e) => e.kind === 'thinking');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstThinkIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(firstThinkIdx);
    expect(events[firstThinkIdx]).toEqual({ kind: 'thinking', text: 'Let me think.' });
  });

  it('does NOT yield thinking_start for a plain-text turn (byte-identical)', async () => {
    const t = new OpenAIResponsesTransport({ client });
    function* s(): Generator<Ev> {
      yield { type: 'response.output_text.delta', delta: 'hello' } as unknown as Ev;
      yield completed();
    }
    const events = await drain(t.readStream(s()));
    expect(events.some((e) => e.kind === 'thinking_start')).toBe(false);
  });
});

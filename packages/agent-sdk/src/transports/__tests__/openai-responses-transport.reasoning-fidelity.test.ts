import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { StreamEvent, Transport } from '../../engine/transport.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;

function reasoningDone(id: string, enc: string, idx: number): Ev {
  return {
    type: 'response.output_item.done',
    output_index: idx,
    item: { id, type: 'reasoning', summary: [], encrypted_content: enc, status: 'completed' },
  } as unknown as Ev;
}
function fcDone(itemId: string, callId: string, name: string, args: string, idx: number): Ev {
  return {
    type: 'response.output_item.done',
    output_index: idx,
    item: { id: itemId, type: 'function_call', call_id: callId, name, arguments: args },
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
function toolBlock(callId: string, name: string, input: unknown): ContentBlock {
  return { type: 'tool_use', toolUseId: callId, toolName: name, toolInput: input } as unknown as ContentBlock;
}

const client = {} as unknown as OpenAI;

describe('OpenAIResponsesTransport — PR4 P3 reasoning-summary thinking_block', () => {
  it('emits a thinking_block (signature omitted) carrying the concatenated summary AFTER the live deltas', async () => {
    const t = new OpenAIResponsesTransport({ client });
    function* s(): Generator<Ev> {
      yield summaryDelta('Let me ');
      yield summaryDelta('think.');
      yield reasoningDone('rs_1', 'E1', 0);
      yield fcDone('fc_1', 'call_1', 'f', '{}', 1);
      yield completed();
    }
    const events = await drain(t.readStream(s()));
    const liveThinking = events.filter((e) => e.kind === 'thinking');
    const block = events.filter((e) => e.kind === 'thinking_block');
    // The live deltas streamed.
    expect(liveThinking.map((e) => (e as { text: string }).text)).toEqual(['Let me ', 'think.']);
    // Exactly ONE thinking_block carrying the concatenated summary, no signature.
    expect(block).toHaveLength(1);
    expect(block[0]).toEqual({ kind: 'thinking_block', thinking: 'Let me think.' });
    expect('signature' in (block[0] as object)).toBe(false);
    // It comes AFTER the last live thinking delta (symmetric with Anthropic).
    const lastLiveIdx = events.lastIndexOf(liveThinking[liveThinking.length - 1]);
    const blockIdx = events.indexOf(block[0]);
    expect(blockIdx).toBeGreaterThan(lastLiveIdx);
  });

  it('emits NO thinking_block when there is no reasoning summary (plain text turn byte-identical)', async () => {
    const t = new OpenAIResponsesTransport({ client });
    function* s(): Generator<Ev> {
      yield { type: 'response.output_text.delta', delta: 'hello' } as unknown as Ev;
      yield completed();
    }
    const events = await drain(t.readStream(s()));
    expect(events.some((e) => e.kind === 'thinking_block')).toBe(false);
    expect(events.some((e) => e.kind === 'thinking')).toBe(false);
  });

  it('NO DOUBLE-ECHO: the thinking_block is display-only — pushAssistant of an unsigned thinking block emits no wire reasoning item', async () => {
    const t = new OpenAIResponsesTransport({ client });
    function* s(): Generator<Ev> {
      yield summaryDelta('reasoning summary');
      yield reasoningDone('rs_1', 'E1', 0);
      yield fcDone('fc_1', 'call_1', 'f', '{}', 1);
      yield completed();
    }
    const events = await drain(t.readStream(s()));
    const done = events.find((e) => e.kind === 'done') as Extract<StreamEvent, { kind: 'done' }>;
    const history: OpenAI.Responses.ResponseInputItem[] = [];
    // The engine folds the (display) thinking_block into asstBlocks; simulate that
    // by handing pushAssistant an unsigned thinking block + the tool_use.
    t.pushAssistant(history, [
      { type: 'thinking', thinking: 'reasoning summary' } as unknown as ContentBlock,
      toolBlock('call_1', 'f', {}),
    ], done.replay);
    // EXACTLY ONE wire reasoning item (the provider's own), before the call.
    const reasoningItems = history.filter((i) => (i as { type?: string }).type === 'reasoning');
    expect(reasoningItems).toHaveLength(1);
    expect(reasoningItems[0]).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'E1' });
    // The display thinking block is never turned into a wire item of its own.
    expect(history.map((i) => (i as { type?: string }).type)).toEqual(['reasoning', 'function_call']);
  });
});

describe('OpenAIResponsesTransport — no per-instance reasoning channel', () => {
  it('does not implement capturedReasoning: the reasoning rides the done event (a shared instance leaked it)', () => {
    const t = new OpenAIResponsesTransport({ client });
    expect((t as Transport).capturedReasoning).toBeUndefined();
  });
});

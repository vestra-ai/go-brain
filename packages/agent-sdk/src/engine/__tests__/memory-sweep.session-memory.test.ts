/**
 * The parity memory sweep never reads the moved memory back as the person's words.
 *
 * RESPONSES_MEMORY_INPUT_V1 moves the memory blocks into the first user input item on GPT-6.1
 * Sol / Luna / Astra, and SWEEP_PREFIX_PARITY_V1 sends the loop's exact request, so the sweep
 * sees that item too. The sweep's prompt says (user_direct) facts and QUOTE lines come from the
 * person's messages; without a guard it could harvest the memory back as things they said. Two
 * guards, both on the wire: the item leads with the plain provenance line (fenceSessionMemory),
 * and the sweep's own prompt names the block as never the user's words. Every other sweep's
 * prompt stays byte-identical.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { runOffloopSweep, MEMORY_SWEEP_PROMPT_PARITY, SWEEP_SESSION_MEMORY_NOTE } from '../memory-sweep.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { SESSION_MEMORY_LEAD, fenceSessionMemory } from '../../contract/injected-user-text.js';
import type { LoopRequest } from '../round-engine.js';
import type { Journal } from '../../kernel/journal/journal.js';

const SYSTEM = 'You are a careful assistant.\n\n<user_memory>\nSends the deck to Priya by Friday.\n</user_memory>\n\nTools you can load: mail_send';
const SPAN = { start: 'You are a careful assistant.'.length, end: 'You are a careful assistant.\n\n<user_memory>\nSends the deck to Priya by Friday.\n</user_memory>'.length };

type Item = { role?: string; content?: string | Array<{ type: string; text: string }> };
/** The body the sweep sends, through the real Responses transport. */
async function sweepBody(loopRequest: LoopRequest): Promise<{ instructions: string; input: Item[] }> {
  const stream = () => (async function* () { /* no events: only the body is read */ })();
  const calls: unknown[] = [];
  const client = { responses: { stream: (body: unknown) => (calls.push(body), stream()) } } as unknown as OpenAI;
  const journal = { project: async () => ({ messages: [], leaf: null }) } as unknown as Journal;
  await runOffloopSweep({
    transport: new OpenAIResponsesTransport({ client }),
    journal,
    model: loopRequest.model,
    system: SYSTEM,
    providerTools: [],
    elision: null,
    loopRequest,
  });
  return calls[0] as { instructions: string; input: Item[] };
}
const textOf = (item: Item | undefined): string =>
  typeof item?.content === 'string' ? item.content : (item?.content ?? []).map((c) => c.text).join('');

describe('the parity sweep on GPT-6.1 Sol with the memory moved', () => {
  const loop: LoopRequest = { model: 'gpt-6.1-sol', system: SYSTEM, tools: [], cacheKey: 'u-1', systemMemorySpan: SPAN };

  it('rides the same leading item, provenance line first, and its prompt says never to capture from it', async () => {
    const body = await sweepBody(loop);
    expect(body.instructions).toBe('You are a careful assistant.\n\nTools you can load: mail_send');
    expect(textOf(body.input[0])).toBe(fenceSessionMemory('<user_memory>\nSends the deck to Priya by Friday.\n</user_memory>'));
    expect(textOf(body.input[0]).startsWith(SESSION_MEMORY_LEAD)).toBe(true);
    const prompt = textOf(body.input[body.input.length - 1]);
    expect(prompt).toBe(MEMORY_SWEEP_PROMPT_PARITY + SWEEP_SESSION_MEMORY_NOTE);
    expect(SWEEP_SESSION_MEMORY_NOTE).toContain("never the user's words");
  });

  it('a loop request with no moved memory keeps today\'s prompt, byte for byte', async () => {
    const { systemMemorySpan: _dropped, ...withoutSpan } = loop;
    const body = await sweepBody(withoutSpan);
    expect(body.instructions).toBe(SYSTEM);
    expect(textOf(body.input[body.input.length - 1])).toBe(MEMORY_SWEEP_PROMPT_PARITY);
  });

  it('a model that keeps the memory in its system prompt never gets the note', async () => {
    const body = await sweepBody({ ...loop, model: 'gpt-5.5' });
    expect(body.instructions).toBe(SYSTEM);
    expect(textOf(body.input[body.input.length - 1])).toBe(MEMORY_SWEEP_PROMPT_PARITY);
  });
});

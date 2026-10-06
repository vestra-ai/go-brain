import { describe, expect, it } from 'vitest';
import { silentLog } from '../../log.js';
import { anthropicSideModel } from '../side-model.js';
import { scriptedClient } from './test-kit.js';

describe('anthropicSideModel', () => {
  it('calls messages.create on the client it is given, with the side model, the cached rules and the limits', async () => {
    const client = scriptedClient(['{"facts":[],"lines":[]}']);
    const side = anthropicSideModel(client, 'claude-haiku-4-5', silentLog);
    const signal = new AbortController().signal;
    const out = await side.complete({ purpose: 'notes', system: 'RULES', user: '<chat_data>\n#1 [Go]: hi\n</chat_data>', maxTokens: 1_500, signal });
    expect(out).toBe('{"facts":[],"lines":[]}');
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 1_500,
      system: [{ type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: '<chat_data>\n#1 [Go]: hi\n</chat_data>' }],
    });
    expect(client.requests[0]!.signal).toBe(signal);
  });

  it('keeps only the text of the answer, and lets a failure reach the caller', async () => {
    const blocks: Array<{ type: string; text?: string }> = [{ type: 'thinking' }, { type: 'text', text: '{"lines":' }, { type: 'text', text: '[]}' }];
    const mixed = { messages: { create: async () => ({ content: blocks }) } };
    const req = { purpose: 'fold' as const, system: 's', user: 'u', maxTokens: 10 };
    expect(await anthropicSideModel(mixed, 'm', silentLog).complete(req)).toBe('{"lines":[]}');
    await expect(anthropicSideModel(scriptedClient([]), 'm', silentLog).complete(req)).rejects.toThrow('no answer left');
  });
});

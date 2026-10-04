import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';

function transportWithSpy() {
  const stream = vi.fn().mockReturnValue((async function* () {})());
  const client = { responses: { stream } } as unknown as OpenAI;
  return { transport: new OpenAIResponsesTransport({ client }), stream };
}
const BASE = { system: 's', tools: [] as ProviderTool[], history: [] as ProviderHistory, maxTokens: 4096 };

describe('OpenAIResponsesTransport.callModel — include reasoning.encrypted_content', () => {
  it('sets include:["reasoning.encrypted_content"] for a reasoning model (gpt-5.5)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE, model: 'gpt-5.5' });
    const body = stream.mock.calls[0][0] as { include?: unknown };
    expect(body.include).toEqual(['reasoning.encrypted_content']);
  });

  it('omits include entirely for a non-reasoning model (byte-identical request)', () => {
    const { transport, stream } = transportWithSpy();
    // an unseeded id resolves to thinking.mode === 'none' (registry fallback)
    transport.callModel({ ...BASE, model: 'gpt-4.1-nonreasoning-xyz' });
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect('include' in body).toBe(false);
  });
});

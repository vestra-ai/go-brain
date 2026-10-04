import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';
import type { ModelProvider } from '../../contract/model-capabilities.js';

const BASE = {
  system: 'you are a helper',
  tools: [] as ProviderTool[],
  history: [] as ProviderHistory,
  maxTokens: 4096,
};

/** A stub OpenAI client whose responses.stream is a recordable spy (same shape as
 *  openai-responses-client-cache.test.ts). */
function stubResponsesClient() {
  const stream = vi.fn().mockReturnValue(
    (async function* () {
      /* only the request body is asserted */
    })(),
  );
  return { stream, client: { responses: { stream } } as unknown as OpenAI };
}

describe('OpenAIResponsesTransport — Meta (muse-spark-1.1) wire path', () => {
  it('routes a muse id to the "meta" provider client lane (gpt stays "openai")', () => {
    const calls: ModelProvider[] = [];
    const createClient = vi.fn((p: ModelProvider) => {
      calls.push(p);
      return stubResponsesClient().client;
    });
    const t = new OpenAIResponsesTransport({ createClient });
    t.callModel({ ...BASE, model: 'muse-spark-1.1' });
    t.callModel({ ...BASE, model: 'gpt-5.6-luna' });
    expect(calls).toEqual(['meta', 'openai']);
  });

  it('muse-spark-1.1 rides the STATELESS encrypted-reasoning contract (store:false + include)', () => {
    const { stream, client } = stubResponsesClient();
    new OpenAIResponsesTransport({ client }).callModel({ ...BASE, model: 'muse-spark-1.1' });
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
  });
});

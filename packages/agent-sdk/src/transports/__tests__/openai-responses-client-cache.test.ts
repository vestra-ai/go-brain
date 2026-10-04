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

/** A stub OpenAI client whose responses.stream is a recordable spy. */
function stubClient() {
  const stream = vi.fn().mockReturnValue(
    (async function* () {
      /* no events */
    })(),
  );
  return { stream, client: { responses: { stream } } as unknown as OpenAI };
}

/**
 * Build a transport whose per-provider factory records which ModelProvider it was
 * asked to build a client for. The factory signature is the new contract:
 * createClient(provider: ModelProvider) => OpenAI.
 */
function transportWithProviderFactory() {
  const calls: ModelProvider[] = [];
  const byProvider = new Map<ModelProvider, ReturnType<typeof stubClient>>();
  const createClient = vi.fn((provider: ModelProvider) => {
    calls.push(provider);
    const c = stubClient();
    byProvider.set(provider, c);
    return c.client;
  });
  return {
    transport: new OpenAIResponsesTransport({ createClient }),
    calls,
    createClient,
    byProvider,
  };
}

describe('OpenAIResponsesTransport — per-provider client cache (§4.8)', () => {
  it('routes an OpenAI model id to provider "openai"', () => {
    const { transport, calls } = transportWithProviderFactory();
    transport.callModel({ ...BASE, model: 'gpt-5.4' });
    expect(calls).toEqual(['openai']);
  });

  it('memoizes one client per provider (same provider built once across calls)', () => {
    const { transport, createClient } = transportWithProviderFactory();
    transport.callModel({ ...BASE, model: 'gpt-5.4' });
    transport.callModel({ ...BASE, model: 'gpt-5.5' }); // also openai
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith('openai');
  });

  it('an injected concrete client short-circuits the per-provider factory', () => {
    const { client, stream } = stubClient();
    const createClient = vi.fn();
    const transport = new OpenAIResponsesTransport({ client, createClient });
    transport.callModel({ ...BASE, model: 'gpt-5.4' });
    expect(createClient).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAIResponsesTransport — lazy missing-key construction (§4.8)', () => {
  it('does NOT invoke the client factory at construction time', () => {
    const createClient = vi.fn(() => {
      throw new Error('OPENAI_API_KEY missing');
    });
    // Construction must be inert — no factory call, no throw.
    expect(() => new OpenAIResponsesTransport({ createClient })).not.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('surfaces a missing-key throw on callModel for the picked provider (classifiable)', () => {
    const createClient = vi.fn((provider: ModelProvider) => {
      if (provider === 'openai') throw new Error('OPENAI_API_KEY missing');
      return { responses: { stream: vi.fn() } } as unknown as OpenAI;
    });
    const transport = new OpenAIResponsesTransport({ createClient });
    // The throw is deferred to the call and is an ordinary Error the loop's
    // classifyError can map — not a process-killing construction crash.
    expect(() => transport.callModel({ ...BASE, model: 'gpt-5.4' })).toThrow(
      'OPENAI_API_KEY missing',
    );
  });
});

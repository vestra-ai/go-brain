import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';
import type { ModelProvider } from '../../contract/model-capabilities.js';

const BASE = {
  system: 'you are a helper',
  tools: [] as ProviderTool[],
  history: [] as ProviderHistory,
  maxTokens: 4096,
};

/** A stub OpenAI client whose chat.completions.stream is a recordable spy. */
function stubClient() {
  const stream = vi.fn().mockReturnValue(
    (async function* () {
      /* no events */
    })(),
  );
  return { stream, client: { chat: { completions: { stream } } } as unknown as OpenAI };
}

/** A transport whose per-provider factory records which ModelProvider it built for. */
function transportWithProviderFactory() {
  const calls: ModelProvider[] = [];
  const byProvider = new Map<ModelProvider, ReturnType<typeof stubClient>>();
  const createClient = vi.fn((provider: ModelProvider) => {
    calls.push(provider);
    const c = stubClient();
    byProvider.set(provider, c);
    return c.client;
  });
  return { transport: new ChatCompletionsTransport({ createClient }), calls, createClient, byProvider };
}

describe('ChatCompletionsTransport — per-provider client cache', () => {
  it('routes a GLM model id to provider "fireworks"', () => {
    const { transport, calls } = transportWithProviderFactory();
    transport.callModel({ ...BASE, model: 'glm-5.2' });
    expect(calls).toEqual(['fireworks']);
  });

  it('routes a Moonshot/OpenAI-compatible id to provider "openai" (byte-identical)', () => {
    const { transport, calls } = transportWithProviderFactory();
    transport.callModel({ ...BASE, model: 'gpt-5.5' });
    expect(calls).toEqual(['openai']);
  });

  it('builds a distinct client per distinct provider (no GPT/GLM cross-talk)', () => {
    const { transport, createClient } = transportWithProviderFactory();
    transport.callModel({ ...BASE, model: 'gpt-5.5' }); // openai
    transport.callModel({ ...BASE, model: 'glm-5.2' }); // fireworks
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith('openai');
    expect(createClient).toHaveBeenCalledWith('fireworks');
  });

  it('memoizes one client per provider across calls', () => {
    const { transport, createClient } = transportWithProviderFactory();
    transport.callModel({ ...BASE, model: 'glm-5.2' });
    transport.callModel({ ...BASE, model: 'glm-5.2' });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith('fireworks');
  });

  it('an injected concrete client short-circuits the per-provider factory', () => {
    const { client, stream } = stubClient();
    const createClient = vi.fn();
    const transport = new ChatCompletionsTransport({ client, createClient });
    transport.callModel({ ...BASE, model: 'glm-5.2' });
    expect(createClient).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('surfaces a missing-key throw on callModel for the picked provider (classifiable, not a construction crash)', () => {
    const createClient = vi.fn((provider: ModelProvider) => {
      if (provider === 'fireworks') throw new Error('FIREWORKS_API_KEY missing');
      return { chat: { completions: { stream: vi.fn() } } } as unknown as OpenAI;
    });
    expect(() => new ChatCompletionsTransport({ createClient })).not.toThrow();
    expect(() => transport_callModel(createClient, 'glm-5.2')).toThrow('FIREWORKS_API_KEY missing');
  });
});

function transport_callModel(createClient: (p: ModelProvider) => OpenAI, model: string) {
  const t = new ChatCompletionsTransport({ createClient });
  return t.callModel({ ...BASE, model });
}

/** A function tool carrying strict:true (mirrors the always-present special tools). */
function strictTool(): ProviderTool {
  return {
    type: 'function',
    function: {
      name: 'AskUserQuestion',
      description: 'ask',
      strict: true,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  } as unknown as ProviderTool;
}

describe('ChatCompletionsTransport — GLM rides the standard Fireworks path (Z.ai seam retired)', () => {
  function bodyFor(model: string, tools: ProviderTool[] = []) {
    const { client, stream } = stubClient();
    const transport = new ChatCompletionsTransport({ client });
    transport.callModel({ ...BASE, model, tools });
    return stream.mock.calls[0][0] as Record<string, unknown>;
  }

  it('GLM sends OpenAI reasoning_effort and NO Z.ai thinking field (the seam is gone)', () => {
    const body = bodyFor('glm-5.2');
    expect(body.reasoning_effort).toBe('high');
    expect(body.thinking).toBeUndefined();
  });

  it('a reasoning OpenAI model still sends reasoning_effort and NO thinking field', () => {
    const body = bodyFor('gpt-5.5');
    expect(body.reasoning_effort).toBe('high');
    expect(body.thinking).toBeUndefined();
  });

  it('GLM no longer forces strict:false — the tool strict flag passes through unchanged', () => {
    const body = bodyFor('glm-5.2', [strictTool()]);
    const tools = body.tools as Array<{ function: { strict?: boolean } }>;
    expect(tools[0].function.strict).toBe(true);
  });

  it('a non-GLM model leaves the tool strict flag untouched', () => {
    const body = bodyFor('gpt-5.5', [strictTool()]);
    const tools = body.tools as Array<{ function: { strict?: boolean } }>;
    expect(tools[0].function.strict).toBe(true);
  });
});

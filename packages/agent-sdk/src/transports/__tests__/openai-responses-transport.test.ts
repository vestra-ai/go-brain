import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { OutputFormat } from '../../contract/output-format.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';

/**
 * Build a transport whose injected client records the request body handed to
 * responses.stream(). The stub returns a trivial async-iterable so callModel's
 * return value is a valid ProviderStream (the loop never reads it here).
 */
function transportWithSpy() {
  const stream = vi.fn().mockReturnValue(
    (async function* () {
      /* no events — the request body is all we assert */
    })(),
  );
  const client = { responses: { stream } } as unknown as OpenAI;
  return { transport: new OpenAIResponsesTransport({ client }), stream };
}

const BASE = {
  model: 'gpt-5.4',
  system: 'you are a helper',
  tools: [] as ProviderTool[],
  history: [] as ProviderHistory,
  maxTokens: 4096,
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as const;

describe('OpenAIResponsesTransport.callModel — outputFormat → text.format', () => {
  it('omits text entirely when no outputFormat is requested (byte-identical request)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE });
    expect(stream).toHaveBeenCalledTimes(1);
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect('text' in body).toBe(false);
  });

  it('spreads text.format = { type:json_schema, strict:true, name, schema } when outputFormat is present', () => {
    const { transport, stream } = transportWithSpy();
    const outputFormat: OutputFormat = {
      type: 'json_schema',
      name: 'routine_spec',
      schema: SCHEMA as unknown as OutputFormat['schema'],
    };
    transport.callModel({ ...BASE, outputFormat });
    const body = stream.mock.calls[0][0] as { text?: { format?: unknown } };
    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        strict: true,
        name: 'routine_spec',
        schema: SCHEMA,
      },
    });
  });

  it('falls back to a default name when outputFormat.name is absent (OpenAI requires a name)', () => {
    const { transport, stream } = transportWithSpy();
    const outputFormat: OutputFormat = {
      type: 'json_schema',
      schema: SCHEMA as unknown as OutputFormat['schema'],
    };
    transport.callModel({ ...BASE, outputFormat });
    const body = stream.mock.calls[0][0] as { text?: { format?: { name?: string } } };
    expect(body.text?.format?.name).toBe('structured_output');
  });
});

describe('OpenAIResponsesTransport.callModel — prompt_cache_key (OpenAI prompt-caching)', () => {
  it('spreads prompt_cache_key onto the request body when cacheKey is present', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE, cacheKey: 'vestra:task-abc' });
    expect(stream).toHaveBeenCalledTimes(1);
    const body = stream.mock.calls[0][0] as { prompt_cache_key?: string; store?: unknown };
    expect(body.prompt_cache_key).toBe('vestra:task-abc');
    // PR3 — stateless: we explicitly opt OUT of server-side response retention.
    expect(body.store).toBe(false);
  });
});

describe('OpenAIResponsesTransport.callModel — stateless contract (PR3: store=false)', () => {
  it('sets store:false on a reasoning model (so encrypted reasoning replays without 404)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE, model: 'gpt-5.4' });
    const body = stream.mock.calls[0][0] as { store?: unknown };
    expect(body.store).toBe(false);
  });

  it('sets store:false on a non-reasoning model too (no server-side retention anywhere)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE, model: 'gpt-4.1' });
    const body = stream.mock.calls[0][0] as { store?: unknown };
    expect(body.store).toBe(false);
  });

  it('requests include:[reasoning.encrypted_content] for a reasoning model (replay on)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE, model: 'gpt-5.4' });
    const body = stream.mock.calls[0][0] as { include?: unknown };
    expect(body.include).toEqual(['reasoning.encrypted_content']);
  });

  it('OMITS include once reasoning replay is disabled (Hermes parity — do not mint blobs we strip)', () => {
    // PR4 review fix: after the invalid_encrypted_content recovery flips the replay kill
    // switch, the preflight drops ALL reasoning from input — so we must also stop asking
    // the endpoint to RETURN encrypted reasoning (Hermes gates `include` on the same flag),
    // else every later turn mints a dead blob we capture, journal, and strip next turn.
    const { transport, stream } = transportWithSpy();
    transport.disableReasoningReplay();
    transport.callModel({ ...BASE, model: 'gpt-5.4' });
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect('include' in body).toBe(false);
  });

  it('strips reasoning ids from the input (store:false → replaying an id 404s)', () => {
    const { transport, stream } = transportWithSpy();
    const history = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'enc1' },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
    ] as unknown as ProviderHistory;
    transport.callModel({ ...BASE, history });
    const body = stream.mock.calls[0][0] as { input: Array<Record<string, unknown>> };
    const reasoning = body.input.find((i) => i.type === 'reasoning')!;
    expect(reasoning).toBeDefined();
    expect('id' in reasoning).toBe(false);
    expect(reasoning.encrypted_content).toBe('enc1');
  });

  it('surfaces a corrupt journal (function_call with no call_id) as a raised error', () => {
    const { transport } = transportWithSpy();
    const history = [
      { type: 'function_call', name: 'Read', arguments: '{}' },
    ] as unknown as ProviderHistory;
    expect(() => transport.callModel({ ...BASE, history })).toThrow(/call_id/i);
  });

  it('drops a foreign-issuer reasoning blob on the wire (PR4 cross-issuer guard)', () => {
    // gpt-5.4 resolves to the openai provider; a foreign-issuer blob can't be decrypted
    // by the openai endpoint → it must be dropped before the wire (and the internal
    // `_issuer` marker stripped from the surviving openai item).
    const { transport, stream } = transportWithSpy();
    const history = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'mine', _issuer: 'openai' },
      { type: 'reasoning', id: 'r2', summary: [], encrypted_content: 'theirs', _issuer: 'google' },
    ] as unknown as ProviderHistory;
    transport.callModel({ ...BASE, model: 'gpt-5.4', history });
    const body = stream.mock.calls[0][0] as { input: Array<Record<string, unknown>> };
    const reasoning = body.input.filter((i) => i.type === 'reasoning');
    expect(reasoning.map((r) => r.encrypted_content)).toEqual(['mine']);
    expect(reasoning.every((r) => !('_issuer' in r))).toBe(true);
  });

  it('omits prompt_cache_key entirely when no cacheKey is requested (contract-level byte-identity guard)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE });
    expect(stream).toHaveBeenCalledTimes(1);
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect('prompt_cache_key' in body).toBe(false);
  });
});

describe('OpenAIResponsesTransport.callModel — OpenAI path byte-identical with per-provider cache', () => {
  it('sends the same request body for a gpt model and uses the injected client (no per-provider build)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE });
    expect(stream).toHaveBeenCalledTimes(1);
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    // The unconstrained loop body is unchanged by the cache refactor.
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'you are a helper',
      input: [],
      tools: [],
      max_output_tokens: 4096,
    });
    expect('text' in body).toBe(false);
  });

  it('memoizes the injected client across two gpt calls (single client instance)', () => {
    const { transport, stream } = transportWithSpy();
    transport.callModel({ ...BASE });
    transport.callModel({ ...BASE });
    // Same injected client both times → two stream invocations, one client.
    expect(stream).toHaveBeenCalledTimes(2);
  });
});

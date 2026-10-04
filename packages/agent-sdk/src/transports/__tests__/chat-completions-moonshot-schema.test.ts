import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { sanitizeMoonshotToolParameters, isMoonshotModel } from '../chat-completions-moonshot-schema.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';

/**
 * PR10 (Hermes parity) — Moonshot/Kimi tool-schema repair. Moonshot accepts a stricter
 * JSON-Schema subset than OpenAI; common shapes (a property with no `type`, a nullable
 * `anyOf`, `nullable`, null enum values) 400 with "not a valid moonshot flavored json
 * schema". Mirrors Hermes' `moonshot_schema.py` (`sanitize_moonshot_tool_parameters` +
 * `is_moonshot_model`).
 */

describe('isMoonshotModel', () => {
  it('matches bare + aggregator-prefixed Kimi/Moonshot slugs', () => {
    expect(isMoonshotModel('kimi-k2.6')).toBe(true);
    expect(isMoonshotModel('moonshotai/Kimi-K2.6')).toBe(true);
    expect(isMoonshotModel('openrouter/moonshotai/kimi-k2.6')).toBe(true);
    expect(isMoonshotModel('nous/moonshotai/kimi-k2')).toBe(true);
  });
  it('does NOT match non-Moonshot models', () => {
    expect(isMoonshotModel('gpt-5.4')).toBe(false);
    expect(isMoonshotModel('claude-opus-4-8')).toBe(false);
    expect(isMoonshotModel(undefined)).toBe(false);
    expect(isMoonshotModel('')).toBe(false);
  });
});

describe('sanitizeMoonshotToolParameters', () => {
  it('Rule 1: fills a missing type on a property schema (infers object/array/string)', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        bare: { description: 'no type' },
        nested: { properties: { x: { type: 'string' } } },
        list: { items: { type: 'string' } },
      },
    }) as any;
    expect(out.properties.bare.type).toBe('string');
    expect(out.properties.nested.type).toBe('object');
    expect(out.properties.list.type).toBe('array');
  });

  it('Rule 2: collapses a nullable anyOf to its single non-null branch', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    }) as any;
    // The null branch is dropped and the single real branch promoted (type on the node).
    expect(out.properties.maybe.anyOf).toBeUndefined();
    expect(out.properties.maybe.type).toBe('string');
  });

  it('strips `nullable` and null/empty enum values', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        a: { type: 'string', nullable: true, enum: ['x', '', null] },
      },
    }) as any;
    expect('nullable' in out.properties.a).toBe(false);
    expect(out.properties.a.enum).toEqual(['x']);
  });

  it('forces a top-level object schema with properties', () => {
    expect(sanitizeMoonshotToolParameters(undefined)).toEqual({ type: 'object', properties: {} });
    const out = sanitizeMoonshotToolParameters({ type: 'string' }) as any;
    expect(out.type).toBe('object');
    expect(out.properties).toEqual({});
  });
});

describe('ChatCompletionsTransport.callModel — Moonshot tool repair gating', () => {
  function transportWithSpy() {
    const calls: any[] = [];
    const client = {
      chat: { completions: { stream: (body: any) => { calls.push(body); return (async function* () {})(); } } },
    } as unknown as OpenAI;
    return { transport: new ChatCompletionsTransport({ client }), calls };
  }
  const tool = { type: 'function' as const, function: { name: 'Read', parameters: { type: 'object', properties: { p: { description: 'no type' } } } } };

  it('repairs tool params (fills missing type) for a Moonshot model', () => {
    const { transport, calls } = transportWithSpy();
    transport.callModel({ model: 'moonshotai/kimi-k2.6', system: 's', tools: [tool], history: [], maxTokens: 100 });
    expect(calls[0].tools[0].function.parameters.properties.p.type).toBe('string');
  });

  it('does NOT repair for a non-Moonshot model (byte-identical)', () => {
    const { transport, calls } = transportWithSpy();
    transport.callModel({ model: 'gpt-5.4', system: 's', tools: [tool], history: [], maxTokens: 100 });
    expect('type' in calls[0].tools[0].function.parameters.properties.p).toBe(false);
  });
});

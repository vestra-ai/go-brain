/**
 * tool-dispatcher.narration.test.ts — the story-spine narration contract.
 *
 * Every tool the native lane serves gains an optional `narration` param at the
 * ONE assembly seam (toAnthropicTool — the transport maps every RawToolOptions
 * through it, MCP included). The model writes intent there; the server mints it
 * into task_story rows from the wire event. Tools themselves NEVER see the key:
 * the dispatcher strips it before gating/executing, so strict zod handlers
 * cannot reject it and no tool behavior can depend on display material.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool, toAnthropicTool } from '../tool-dispatcher.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const onPause = async () => 'PAUSED_HALT';

describe('toAnthropicTool — narration param injection', () => {
  it('adds an optional narration property to object schemas and leaves required untouched', () => {
    const tool = toAnthropicTool({
      name: 'Read',
      description: 'Reads a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async () => 'ok',
    });
    const schema = tool.input_schema as {
      properties: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(schema.properties.narration).toBeDefined();
    expect(schema.properties.narration.type).toBe('string');
    // The param description IS the contract: intent voice, user's words.
    expect(schema.properties.narration.description).toMatch(/present-tense/i);
    expect(schema.required).toEqual(['path']); // never demanded at schema level
    expect(schema.properties.path).toEqual({ type: 'string' });
  });

  it('does not clobber a tool that declares its own narration param', () => {
    const own = { type: 'string', description: 'mine' };
    const tool = toAnthropicTool({
      name: 'Custom',
      description: 'has its own',
      parameters: { type: 'object', properties: { narration: own } },
      execute: async () => 'ok',
    });
    const schema = tool.input_schema as { properties: Record<string, unknown> };
    expect(schema.properties.narration).toEqual(own);
  });

  it('leaves a genuinely non-object schema untouched', () => {
    const bare = { type: 'string' } as Record<string, unknown>;
    expect(toAnthropicTool({
      name: 'Bare', description: '', parameters: bare, execute: async () => 'ok',
    }).input_schema).toEqual(bare);
  });

  it('a property-less object schema still gets narration injected (every object-shaped tool narrates)', () => {
    const bare = { type: 'object' } as Record<string, unknown>;
    const schema = toAnthropicTool({
      name: 'Bare', description: '', parameters: bare, execute: async () => 'ok',
    }).input_schema as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(schema.properties?.narration).toBeDefined();
  });

  it('does not mutate the original parameters object (assembly must be pure)', () => {
    const params = { type: 'object', properties: { q: { type: 'string' } } };
    toAnthropicTool({ name: 'T', description: '', parameters: params, execute: async () => 'ok' });
    expect((params.properties as Record<string, unknown>).narration).toBeUndefined();
  });
});

describe('gateAndDispatchTool — narration strip', () => {
  it('strips narration before the gate AND the execute (strict handlers never see it)', async () => {
    const execute = vi.fn(async (args: unknown) => {
      // Simulates a strict zod handler: unknown keys are a contract breach.
      expect('narration' in (args as Record<string, unknown>)).toBe(false);
      return 'ran';
    });
    const gate = gateOf({ decision: 'allow' });
    const r = await gateAndDispatchTool(
      { name: 'Read', description: '', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execute },
      { path: '/tmp/x', narration: 'Reading your notes file' },
      'tu-1',
      gate as never,
      onPause,
    );
    expect(r.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith({ path: '/tmp/x' }, expect.anything());
    const gatedCall = gate.gateTool.mock.calls[0][0] as ToolCall;
    expect((gatedCall.toolInput as Record<string, unknown>).narration).toBeUndefined();
    expect((gatedCall.toolInput as Record<string, unknown>).path).toBe('/tmp/x');
  });

  it('a call without narration executes byte-identically', async () => {
    const execute = vi.fn(async () => 'ran');
    const r = await gateAndDispatchTool(
      { name: 'Read', description: '', parameters: { type: 'object', properties: {} }, execute },
      { path: '/tmp/x' },
      'tu-2',
      gateOf({ decision: 'allow' }) as never,
      onPause,
    );
    expect(r.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith({ path: '/tmp/x' }, expect.anything());
  });
});

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import type { RawToolOptions } from '../../tools/tool-types.js';

/**
 * PR-SKILLS — the OpenAI Responses function-tool build path must send a REAL
 * JSON Schema (converted from the Zod params), not the raw Zod object, and must
 * honor `strict` ONLY where the converted schema is provably OpenAI-strict-
 * compatible (so a single optional-param tool can never 400 the whole request).
 *
 * These assert the SHAPE OpenAI actually receives. The pre-fix transport sent
 * the raw Zod object (`{def:...}`) with strict hardcoded false → fails every
 * assertion below.
 */

const noop = (): string => '';

function rawTool(over: Partial<RawToolOptions>): RawToolOptions {
  return {
    name: 'T',
    description: 'd',
    parameters: z.object({ name: z.string() }),
    execute: noop,
    ...over,
  };
}

function buildOne(over: Partial<RawToolOptions>): OpenAI.Responses.FunctionTool {
  const t = new OpenAIResponsesTransport({ client: {} as unknown as OpenAI });
  const out = t.buildTools([rawTool(over)]);
  return out[0] as OpenAI.Responses.FunctionTool;
}

describe('OpenAIResponsesTransport.buildTools — Zod → JSON Schema conversion (Defect B)', () => {
  it('converts the Skill tool Zod params to a real JSON Schema with properties/required', () => {
    // The live-bug tool: single `name` param. The raw-Zod blob has no `properties`.
    const tool = buildOne({
      name: 'Skill',
      strict: true,
      parameters: z.object({
        name: z.string().describe('The skill slug to load'),
      }),
    });
    const params = tool.parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
    const props = params.properties as Record<string, unknown>;
    expect(props.name).toBeDefined();
    expect(params.required).toContain('name');
    expect(params.additionalProperties).toBe(false);
    // And the raw-Zod internals must NOT leak through.
    expect('def' in params).toBe(false);
  });

  it('still emits a real JSON Schema (no raw Zod) for a non-strict-compatible tool', () => {
    const tool = buildOne({
      strict: true,
      parameters: z.object({ a: z.string().nullable().optional() }),
    });
    const params = tool.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    expect(props.a).toBeDefined();
    expect('def' in params).toBe(false);
  });
});

describe('OpenAIResponsesTransport.buildTools — per-tool strict gate (Defect A + 400-safety)', () => {
  it('sets strict:true when the converted schema IS OpenAI-strict-compatible', () => {
    // Skill's schema: all keys required, additionalProperties:false → strict-safe.
    const tool = buildOne({
      name: 'Skill',
      strict: true,
      parameters: z.object({ name: z.string() }),
    });
    expect(tool.strict).toBe(true);
  });

  it('downgrades to strict:false (NEVER 400) when an optional param makes the schema non-strict-compatible', () => {
    // Bash/Read/Grep shape: an optional field → key not in `required` → OpenAI
    // strict would 400. We must send strict:false WITH the real schema.
    const tool = buildOne({
      strict: true,
      parameters: z.object({
        command: z.string(),
        timeout: z.number().int().nullable().optional(),
      }),
    });
    expect(tool.strict).toBe(false);
    // …but the real schema is STILL present (Fix B fixes the wrong-key bug even at strict:false).
    const params = tool.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    expect(props.command).toBeDefined();
    expect(props.timeout).toBeDefined();
    expect(params.required).toContain('command');
  });

  it('downgrades TaskOutput (required z.number().int() → minimum/maximum) to strict:false WITH real schema', () => {
    // The adversarial-found 400 trap: an all-REQUIRED int field passes the
    // required+additionalProperties checks but emits `minimum`/`maximum`, which
    // OpenAI strict REJECTS with a 400 on the whole request. Must be strict:false.
    const tool = buildOne({
      name: 'TaskOutput',
      strict: true,
      parameters: z.object({
        task_id: z.string(),
        block: z.boolean(),
        timeout: z.number().int(),
      }),
    });
    expect(tool.strict).toBe(false);
    // Real schema still sent → wrong-key class still fixed (no regression to the original bug).
    const params = tool.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    expect(props.task_id).toBeDefined();
    expect(props.timeout).toBeDefined();
    expect(params.required).toEqual(expect.arrayContaining(['task_id', 'block', 'timeout']));
  });

  it('downgrades Monitor (required timeout_ms z.number().int()) to strict:false WITH real schema', () => {
    const tool = buildOne({
      name: 'Monitor',
      strict: true,
      parameters: z.object({
        description: z.string(),
        command: z.string(),
        timeout_ms: z.number().int(),
        persistent: z.boolean(),
      }),
    });
    expect(tool.strict).toBe(false);
    const params = tool.parameters as Record<string, unknown>;
    expect((params.properties as Record<string, unknown>).timeout_ms).toBeDefined();
  });

  it('downgrades to strict:false for a z.record(additionalProperties:{}) param (record tools)', () => {
    const tool = buildOne({
      strict: true,
      parameters: z.object({
        metadata: z.record(z.string(), z.unknown()),
      }),
    });
    expect(tool.strict).toBe(false);
    const params = tool.parameters as Record<string, unknown>;
    expect((params.properties as Record<string, unknown>).metadata).toBeDefined();
  });

  it('honors an explicit strict:false even on a strict-compatible schema', () => {
    const tool = buildOne({ strict: false, parameters: z.object({ name: z.string() }) });
    expect(tool.strict).toBe(false);
  });

  it('treats a missing strict flag as false', () => {
    // No `strict` key at all (the default rawTool omits it) → falsy → strict:false.
    const tool = buildOne({ parameters: z.object({ name: z.string() }) });
    expect(tool.strict).toBe(false);
  });
});

describe('OpenAIResponsesTransport.buildTools — no-params / null safety', () => {
  it('does not crash and sends an empty-object schema when parameters is null', () => {
    const tool = buildOne({ strict: true, parameters: null });
    const params = tool.parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
    expect(params.additionalProperties).toBe(false);
    // empty object: no properties → strict-compatible → strict honored.
    expect(tool.strict).toBe(true);
  });

  it('does not crash when parameters is undefined', () => {
    const tool = buildOne({ strict: true, parameters: undefined });
    const params = tool.parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
  });
});

describe('OpenAIResponsesTransport.buildTools — whitelist tightening is a no-op on real strict tools', () => {
  // The 6 production tools that are genuinely flat + keyword-free MUST stay
  // strict:true after the whitelist was tightened to OpenAI strict's true
  // supported set (no prefixItems/oneOf/allOf/nullable). Faithful equivalents of
  // each tool's real param schema.
  const STRICT_TOOLS: Record<string, RawToolOptions['parameters']> = {
    Skill: z.object({ name: z.string().describe('slug') }),
    Write: z.object({ file_path: z.string(), content: z.string() }),
    TaskStop: z.object({ task_id: z.string() }),
    Agent: z.object({ description: z.string(), subagent_type: z.string(), prompt: z.string() }),
    Ability: z.object({ name: z.string() }),
    ExitPlanMode: z.object({ plan: z.string() }),
  };

  for (const [name, parameters] of Object.entries(STRICT_TOOLS)) {
    it(`${name} is STILL strict:true (no false downgrade)`, () => {
      const tool = buildOne({ name, strict: true, parameters });
      expect(tool.strict).toBe(true);
      // And it still carries a real converted schema.
      const params = tool.parameters as Record<string, unknown>;
      expect(params.type).toBe('object');
      expect('def' in params).toBe(false);
    });
  }

  it('a strict tool with a TUPLE param (prefixItems) is downgraded to strict:false, real schema sent', () => {
    const tool = buildOne({ strict: true, parameters: z.object({ pair: z.tuple([z.string(), z.string()]) }) });
    expect(tool.strict).toBe(false);
    expect(JSON.stringify(tool.parameters)).toContain('prefixItems');
  });

  it('a strict tool with an INTERSECTION param (allOf) is downgraded to strict:false, real schema sent', () => {
    const tool = buildOne({
      strict: true,
      parameters: z.object({ ab: z.intersection(z.object({ p: z.string() }), z.object({ q: z.string() })) }),
    });
    expect(tool.strict).toBe(false);
    expect(JSON.stringify(tool.parameters)).toContain('allOf');
  });
});

/**
 * This describe originally pinned the OpenAI fix to the OpenAI lane, asserting the
 * Anthropic lane still passed raw Zod so that PR could not silently change
 * Anthropic's cached prefix bytes. Both lanes convert now (the narration injector
 * does it for every provider), so it pins the sibling lane's shape instead: a
 * cross-lane guard that the OpenAI strict gate never leaks into Anthropic's
 * `input_schema`. The Anthropic contract itself lives in
 * anthropic-transport.tool-schema.test.ts.
 */
describe('Anthropic sibling-lane guard — converted JSON Schema, no OpenAI strict massaging', () => {
  it('AnthropicMessagesTransport.buildTools ships converted JSON Schema, not the Zod object', () => {
    const zodParams = z.object({ name: z.string() });
    // buildTools never touches the client; a stub is fine (no network).
    const t = new AnthropicMessagesTransport({ client: {} as unknown as Anthropic });
    const out = t.buildTools([rawTool({ name: 'Skill', strict: true, parameters: zodParams })]);
    const tool = out[0] as { name: string; input_schema: Record<string, unknown> };
    expect(tool.name).toBe('Skill');
    expect(tool.input_schema).not.toBe(zodParams);
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.properties).toHaveProperty('name');
    // Anthropic needs no dialect declaration — it is ~57 bytes of waste per tool.
    expect(tool.input_schema.$schema).toBeUndefined();
    // `strict` is an OpenAI-only concept; the Anthropic tool shape has no such key.
    expect(tool).not.toHaveProperty('strict');
  });
});

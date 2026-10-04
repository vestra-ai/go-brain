/**
 * PR3 3b — fail-CLOSED at preflight when an OpenAI structured-output target
 * is NOT strict-compatible, with ZERO provider call.
 *
 * `toResponsesTextFormat` sends the structured-output schema with `strict:true`.
 * OpenAI strict requires EVERY key in `properties` to be in `required` (+ the
 * additionalProperties:false / keyword-whitelist rules `isOpenAIStrictCompatible`
 * encodes). A user schema with an OPTIONAL field passes our subset preflight, then
 * 400s at OpenAI — but works on Claude (Claude tolerates it). So for provider ===
 * openai we must reject the doomed request at preflight (a clean
 * outcome, no billed provider call) instead of paying for the 400.
 *
 * The gate keys on the PROVIDER VALUE (`resolveCapabilities(model).provider`),
 * NOT a runtime/HarnessId branch — so the Anthropic path is byte-identical and
 * still accepts optional-field schemas.
 *
 * Layer 1 here unit-tests the pure decision helper `openaiStrictPreflightFailure`.
 * Layer 2 (epilogue-no-call) drives the real epilogue with a callModel SPY and
 * asserts the provider was NEVER called on a fail-closed preflight.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  NativeHarness,
  openaiStrictPreflightFailure,
} from '../native-harness.js';
import { FakeTransport, type StreamEvent } from '../transport.js';
import type { OutputFormat } from '../../contract/output-format.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';

// A schema with an OPTIONAL field: `note` is in `properties` but NOT in `required`.
// Strict-incompatible (OpenAI 400s) but Claude-tolerated. Valid in OUR subset
// (additionalProperties:false, no forbidden keywords) so the subset preflight passes.
const OPTIONAL_FIELD_SCHEMA: OutputFormat = {
  type: 'json_schema',
  name: 'with_optional',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['answer'], // `note` deliberately omitted → optional
  },
};

// A fully strict-compatible schema: every property is required.
const ALL_REQUIRED_SCHEMA: OutputFormat = {
  type: 'json_schema',
  name: 'all_required',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
};

describe('openaiStrictPreflightFailure — provider-gated strict preflight (3b, pure)', () => {
  it('openai + optional-field schema → a clean fail-closed outcome (NOT null)', () => {
    const out = openaiStrictPreflightFailure('openai', OPTIONAL_FIELD_SCHEMA.schema);
    expect(out).not.toBeNull();
    // Routes to the existing structured-output failure kind (clean, no provider call).
    expect(out!.kind).toBe('max_structured_output_retries');
    expect(out!.raw.subtype).toBe('strict_schema_incompatible');
    expect(out!.raw.errors.join(' ')).toMatch(/strict|required|optional/i);
  });

  it('anthropic + the SAME optional-field schema → null (byte-identical: Claude tolerates it)', () => {
    expect(openaiStrictPreflightFailure('anthropic', OPTIONAL_FIELD_SCHEMA.schema)).toBeNull();
  });

  it('google + optional-field schema → null (gate is openai only)', () => {
    expect(openaiStrictPreflightFailure('google', OPTIONAL_FIELD_SCHEMA.schema)).toBeNull();
  });

  it('openai + a fully strict-compatible schema → null (proceeds normally)', () => {
    expect(openaiStrictPreflightFailure('openai', ALL_REQUIRED_SCHEMA.schema)).toBeNull();
  });
});

// ── Layer 2: the real epilogue must make ZERO provider call on fail-closed ──────
function scriptedDone(): StreamEvent[] {
  return [
    { kind: 'text', text: '{"answer":"hi"}' },
    { kind: 'done', stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

function minimalCfg(transport: FakeTransport, outputFormat: OutputFormat): NativeConfig {
  return {
    onAttached: () => {},
    maxTurns: 1,
    transport,
    outputFormat,
  } as unknown as NativeConfig;
}

function ctxFor(model: string, cfg: NativeConfig): HarnessContext<NativeConfig> {
  return { taskId: 't1', sessionId: 's1', cwd: '/tmp', model, signal: new AbortController().signal, config: cfg };
}

const COMPLETED = {
  kind: 'completed' as const,
  summary: 'done',
  costUsd: 0,
  numTurns: 1,
  durationMs: 1,
  modelUsage: {},
  raw: { subtype: 'success', errors: [] },
};

describe('applyStructuredOutputEpilogue — fail-closed preflight makes NO provider call (3b)', () => {
  it('openai + optional-field schema → max_structured_output_retries with ZERO callModel', async () => {
    const transport = new FakeTransport(scriptedDone());
    const callSpy = vi.spyOn(transport, 'callModel');
    const cfg = minimalCfg(transport, OPTIONAL_FIELD_SCHEMA);
    const harness = new NativeHarness();

    // Private method — driven directly so we can assert the no-call invariant on
    // the REAL wired path (not just the helper).
    const epilogue = (
      harness as unknown as {
        applyStructuredOutputEpilogue: (
          format: OutputFormat,
          completed: typeof COMPLETED,
          ctx: HarnessContext<NativeConfig>,
          transport: FakeTransport,
          history: unknown,
          cumulativeCostUsd: number,
        ) => Promise<{ outcome: { kind: string }; cumulativeCostUsd: number }>;
      }
    ).applyStructuredOutputEpilogue;

    const result = await epilogue.call(
      harness,
      OPTIONAL_FIELD_SCHEMA,
      COMPLETED,
      ctxFor('gpt-5.5', cfg),
      transport,
      transport.emptyHistory(),
      0,
    );

    expect(result.outcome.kind).toBe('max_structured_output_retries');
    // THE INVARIANT: a doomed strict request was never sent to the provider.
    expect(callSpy).not.toHaveBeenCalled();
    // …and we never billed for a call we didn't make.
    expect(result.cumulativeCostUsd).toBe(0);
  });

  it('anthropic + the SAME optional-field schema → DOES call the model (Claude path unchanged)', async () => {
    const transport = new FakeTransport(scriptedDone());
    const callSpy = vi.spyOn(transport, 'callModel');
    const cfg = minimalCfg(transport, OPTIONAL_FIELD_SCHEMA);
    const harness = new NativeHarness();

    const epilogue = (
      harness as unknown as {
        applyStructuredOutputEpilogue: (
          format: OutputFormat,
          completed: typeof COMPLETED,
          ctx: HarnessContext<NativeConfig>,
          transport: FakeTransport,
          history: unknown,
          cumulativeCostUsd: number,
        ) => Promise<{ outcome: { kind: string } }>;
      }
    ).applyStructuredOutputEpilogue;

    const result = await epilogue.call(
      harness,
      OPTIONAL_FIELD_SCHEMA,
      COMPLETED,
      ctxFor('claude-sonnet-4-6', cfg),
      transport,
      transport.emptyHistory(),
      0,
    );

    // Claude tolerates the optional field → the constrained call IS made and the
    // scripted valid JSON validates → success rides out on the completed outcome.
    expect(callSpy).toHaveBeenCalled();
    expect(result.outcome.kind).toBe('completed');
  });

  it('openai + a fully strict-compatible schema → DOES call the model (proceeds)', async () => {
    const transport = new FakeTransport(scriptedDone());
    const callSpy = vi.spyOn(transport, 'callModel');
    const cfg = minimalCfg(transport, ALL_REQUIRED_SCHEMA);
    const harness = new NativeHarness();

    const epilogue = (
      harness as unknown as {
        applyStructuredOutputEpilogue: (
          format: OutputFormat,
          completed: typeof COMPLETED,
          ctx: HarnessContext<NativeConfig>,
          transport: FakeTransport,
          history: unknown,
          cumulativeCostUsd: number,
        ) => Promise<{ outcome: { kind: string } }>;
      }
    ).applyStructuredOutputEpilogue;

    const result = await epilogue.call(
      harness,
      ALL_REQUIRED_SCHEMA,
      COMPLETED,
      ctxFor('gpt-5.5', cfg),
      transport,
      transport.emptyHistory(),
      0,
    );

    expect(callSpy).toHaveBeenCalled();
    expect(result.outcome.kind).toBe('completed');
  });
});

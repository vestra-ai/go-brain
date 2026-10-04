import { describe, it, expect, vi } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import type { OutputFormat } from '../../contract/output-format.js';

/**
 * E2: when callModel is given `outputFormat`, the Anthropic transport MERGES a
 * json_schema `format` into the SAME `output_config` object that already carries
 * `effort` (from the thinking resolver) — without clobbering effort, and without
 * perturbing system / tools / messages / cache_control. When `outputFormat` is
 * absent the request body is byte-identical to today.
 *
 * We assert via the streamed-request builder: a mock Anthropic client captures
 * the exact body passed to `messages.stream`. The transport returns the stream
 * handle directly from callModel and never iterates it here, so the mock just
 * records and returns a sentinel.
 */

/** A mock client whose messages.stream records the (body, opts) it was called with. */
function makeMockClient() {
  const calls: Array<{ body: any; opts: any }> = [];
  const stream = vi.fn((body: any, opts: any) => {
    calls.push({ body, opts });
    return { __sentinel: 'stream' } as unknown;
  });
  const client = { messages: { stream } } as any;
  return { client, calls };
}

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, score: { type: 'number' } },
  required: ['title', 'score'],
  additionalProperties: false,
} as const;

const FORMAT: OutputFormat = {
  type: 'json_schema',
  name: 'report',
  schema: SCHEMA as unknown as Record<string, unknown>,
};

/** Base callModel params shared by every case (model with effort → output_config exists). */
function baseParams() {
  return {
    // Opus 4.6 is an 'adaptive' model in the registry → cfg.outputConfig = { effort } is present.
    model: 'claude-opus-4-6',
    system: 'SYSTEM PREFIX',
    tools: [
      { name: 'A', description: 'a', input_schema: { type: 'object' } },
      { name: 'B', description: 'b', input_schema: { type: 'object' } },
    ] as unknown[],
    history: [{ role: 'user', content: 'hi' }] as unknown,
    maxTokens: 8192,
  };
}

describe('AnthropicMessagesTransport — E2 outputFormat enforcement', () => {
  it('merges { format: json_schema } into the existing output_config (effort preserved)', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });

    t.callModel({ ...baseParams(), outputFormat: FORMAT });

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    // effort must survive the merge (adaptive model → effort present).
    expect(body.output_config.effort).toBe('high');
    // format is merged onto the SAME object.
    expect(body.output_config.format).toEqual({
      type: 'json_schema',
      name: 'report',
      schema: SCHEMA,
    });
  });

  it('does not perturb system / tools / messages / cache_control when enforcing format', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });

    // Baseline body WITHOUT outputFormat.
    t.callModel({ ...baseParams() });
    const noFmt = calls[0].body;

    // Body WITH outputFormat — same params otherwise.
    t.callModel({ ...baseParams(), outputFormat: FORMAT });
    const withFmt = calls[1].body;

    // The ONLY difference is output_config.format. system/tools/messages identical.
    expect(withFmt.system).toEqual(noFmt.system);
    expect(withFmt.tools).toEqual(noFmt.tools);
    expect(withFmt.messages).toEqual(noFmt.messages);
    // cache_control on the system tail block is untouched.
    expect(withFmt.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // format only appears on the with-format call.
    expect(noFmt.output_config?.format).toBeUndefined();
    expect(withFmt.output_config.format).toBeDefined();
  });

  it('absent outputFormat leaves the request byte-identical to today (no format key)', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });

    t.callModel({ ...baseParams() });
    const body = calls[0].body;

    // output_config still exists (effort), but carries NO format key at all.
    expect(body.output_config).toEqual({ effort: 'high' });
    expect('format' in body.output_config).toBe(false);
  });

  it('on a model with NO effort, outputFormat still creates output_config:{format} (no effort key)', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });

    // Haiku 4.5 is 'enabled' with no effort → cfg.outputConfig is undefined today.
    t.callModel({
      ...baseParams(),
      model: 'claude-haiku-4-5',
      outputFormat: FORMAT,
    });
    const body = calls[0].body;

    expect(body.output_config.format).toEqual({
      type: 'json_schema',
      name: 'report',
      schema: SCHEMA,
    });
    expect('effort' in body.output_config).toBe(false);
  });

  it('a model with no effort and NO outputFormat sends no output_config (unchanged)', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });

    t.callModel({ ...baseParams(), model: 'claude-haiku-4-5' });
    const body = calls[0].body;

    expect('output_config' in body).toBe(false);
  });
});

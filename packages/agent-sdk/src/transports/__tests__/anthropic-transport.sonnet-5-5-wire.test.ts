/**
 * The request the Anthropic transport builds for Sonnet 5.5 (`claude-sonnet-5-5`).
 *
 * Sonnet 5.5 400s on `thinking:{type:'disabled'}`, on a manual budget, on forced
 * `tool_choice` ('any' / 'tool') and on non-default `temperature` / `top_p` / `top_k`
 * (Anthropic docs, 2026-09-28 release). This pins the whole body: adaptive thinking with
 * display:'summarized' (so the notes it writes between tool calls stream as thinking
 * text instead of going quiet), effort 'medium', and none of the rejected fields, on the
 * main turn, on a low-effort side call and with the thinking kill switch thrown. It also
 * pins the row's own 512-token cache floor on the wire (Sonnet 5's is 1,024).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { estimateTokens } from '../../kernel/journal/token-ledger.js';

function capture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  let body: Record<string, unknown> | undefined;
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        body = params;
        return { async *[Symbol.asyncIterator]() {}, async finalMessage() { return {}; } };
      },
    },
  } as unknown as Anthropic;
  new AnthropicMessagesTransport({ client }).callModel({
    model: 'claude-sonnet-5-5',
    system: 'S',
    tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }],
    history: [{ role: 'user', content: 'go' }],
    maxTokens: 8192,
    ...extra,
  } as Parameters<AnthropicMessagesTransport['callModel']>[0]);
  if (!body) throw new Error('messages.stream was never called');
  return body;
}

function expectNoRejectedField(body: Record<string, unknown>) {
  for (const key of ['tool_choice', 'temperature', 'top_p', 'top_k']) expect(key in body, key).toBe(false);
  expect(JSON.stringify(body)).not.toMatch(/"disabled"|between_tools|budget_tokens/);
}

describe('Anthropic wire: claude-sonnet-5-5', () => {
  afterEach(() => {
    delete process.env.NATIVE_THINKING;
  });

  it('a main turn sends adaptive + summarized thinking at effort medium, nothing Sonnet 5.5 rejects', () => {
    const body = capture();
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expectNoRejectedField(body);
  });

  it('a low-effort side call lowers effort only; thinking stays adaptive', () => {
    const body = capture({ reasoningEffort: 'low' });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expectNoRejectedField(body);
  });

  it('the NATIVE_THINKING kill switch omits thinking (adaptive by default), never disables it', () => {
    process.env.NATIVE_THINKING = 'off';
    const body = capture();
    expect('thinking' in body).toBe(false);
    expectNoRejectedField(body);
  });

  it('a fleet prefix between 512 and 1,024 tokens earns its own breakpoint (the 5.5 cache floor)', () => {
    const fleet = 'FLEET-STATIC '.repeat(215);
    const tokens = estimateTokens(fleet);
    expect(tokens).toBeGreaterThanOrEqual(512);
    expect(tokens).toBeLessThan(1024);
    const body = capture({ system: `${fleet}SESSION-TAIL`, systemFleetPrefixChars: fleet.length });
    expect(body.system).toEqual([
      { type: 'text', text: fleet, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'SESSION-TAIL', cache_control: { type: 'ephemeral' } },
    ]);
  });
});

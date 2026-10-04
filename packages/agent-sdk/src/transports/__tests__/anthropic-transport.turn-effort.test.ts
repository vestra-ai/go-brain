/**
 * Transport.callModel `turnEffort` on the Anthropic wire (SWEEP_EFFORT_MESSAGE_V1).
 *
 * On a row that takes a per-message effort change (registry thinking.perMessageEffort) with
 * thinking on, the request is the same request plus ONE effort-only message,
 * `{role:'system', content:[], output_config:{effort}}`, just before the last message, under the
 * `mid-conversation-output-config-2026-07-01` beta (Anthropic docs, checked 2026-10-04). It goes
 * in after the breakpoints are placed, so every cache_control marker sits where it would without
 * it, and the message carries none. Anywhere else (a row without the capability, thinking off,
 * an empty history) the request is byte-identical to one without `turnEffort`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport, MID_CONVERSATION_OUTPUT_CONFIG_BETA } from '../anthropic-transport.js';

afterEach(() => {
  delete process.env.NATIVE_THINKING;
});

interface Sent {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function send(model: string, history: unknown[], extra: Record<string, unknown> = {}, system = 'S'): Sent {
  let sent: Sent | undefined;
  const client = {
    messages: {
      stream(params: Record<string, unknown>, opts?: { headers?: Record<string, string> }) {
        sent = { body: JSON.parse(JSON.stringify(params)), headers: { ...(opts?.headers ?? {}) } };
        return { async *[Symbol.asyncIterator]() {}, async finalMessage() { return {}; } };
      },
    },
  } as unknown as Anthropic;
  new AnthropicMessagesTransport({ client }).callModel({
    model, system,
    tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }],
    history, maxTokens: 8192, ...extra,
  } as Parameters<AnthropicMessagesTransport['callModel']>[0]);
  if (!sent) throw new Error('messages.stream was never called');
  return sent;
}

const EFFORT_MESSAGE = { role: 'system', content: [], output_config: { effort: 'low' } };
const SHORT = [
  { role: 'user', content: 'Plan the migration.' },
  { role: 'assistant', content: [{ type: 'text', text: 'Here is the plan.' }] },
  { role: 'user', content: 'Now the memory sweep.' },
];
/** Thirty tool rounds: the trailing turn spans past the 20-block lookback, so an intermediate breakpoint is placed too. */
const LONG = [
  { role: 'user', content: 'Tidy every file.' },
  ...Array.from({ length: 30 }, (_, i) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { path: `f${i}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: `body ${i} `.repeat(80) }] },
  ]).flat(),
  { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  { role: 'user', content: 'Now the memory sweep.' },
];
const markerIndices = (messages: unknown[]) =>
  messages.flatMap((m, i) => (JSON.stringify(m).includes('cache_control') ? [i] : []));

describe('turnEffort on a row that takes a per-message effort change', () => {
  it.each(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])(
    '%s: the same request plus the effort message before the last turn, and the beta',
    (model) => {
      const plain = send(model, SHORT);
      const lowered = send(model, SHORT, { turnEffort: 'low' });
      const messages = lowered.body.messages as unknown[];
      expect(messages).toHaveLength(SHORT.length + 1);
      expect(messages[SHORT.length - 1]).toEqual(EFFORT_MESSAGE); // exact: no breakpoint on it
      // Remove that one message and it is the request without turnEffort, byte for byte:
      // the top-level effort (the cache key) and every breakpoint included.
      const rest = messages.filter((_, i) => i !== SHORT.length - 1);
      expect({ ...lowered.body, messages: rest }).toEqual(plain.body);
      expect(plain.headers['anthropic-beta']).toBeUndefined();
      expect(lowered.headers['anthropic-beta']).toBe(MID_CONVERSATION_OUTPUT_CONFIG_BETA);
    },
  );

  it('every breakpoint sits where it would without the message, the intermediate one included', () => {
    const plain = send('claude-fable-5-1', LONG);
    const lowered = send('claude-fable-5-1', LONG, { turnEffort: 'low' });
    const plainMarks = markerIndices(plain.body.messages as unknown[]);
    expect(plainMarks.length).toBe(2); // rolling + intermediate: the case a shifted index would break
    const rest = (lowered.body.messages as unknown[]).filter((m) => (m as { role: string }).role !== 'system');
    expect(rest).toEqual(plain.body.messages);
    expect(markerIndices(rest)).toEqual(plainMarks);
  });
});

describe('anywhere else turnEffort changes nothing', () => {
  it.each(['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'])(
    '%s (no per-message effort): byte-identical body and headers',
    (model) => {
      expect(send(model, SHORT, { turnEffort: 'low' })).toEqual(send(model, SHORT));
    },
  );

  it('thinking off (NATIVE_THINKING=off) on a capable row: byte-identical, no message', () => {
    process.env.NATIVE_THINKING = 'off';
    expect(send('claude-opus-5', SHORT, { turnEffort: 'low' })).toEqual(send('claude-opus-5', SHORT));
  });

  it('an empty history: nothing to place it before, byte-identical', () => {
    expect(send('claude-opus-5-5', [], { turnEffort: 'low' })).toEqual(send('claude-opus-5-5', []));
  });
});

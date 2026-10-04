import { describe, it, expect, vi } from 'vitest';
import { createGeminiInteractionsAccumulator } from '../gemini-interactions-accumulator.js';
import type { GeminiInteractionsEvent } from '../gemini-interactions-wire.js';
import type { StreamEvent } from '../../engine/transport.js';

/** A tool round: signed thought → text → one function_call streamed in 3 argument fragments. */
export const TOOL_ROUND: GeminiInteractionsEvent[] = [
  { event_type: 'interaction.created', interaction: { id: 'v1_int', status: 'in_progress' } },
  { event_type: 'step.start', index: 0, step: { type: 'thought' } },
  { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'I should read the file' } } },
  { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig-A' } },
  { event_type: 'step.stop', index: 0 },
  { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
  { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Let me ' } },
  { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'look.' } },
  { event_type: 'step.stop', index: 1 },
  { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'fc_1', name: 'Read', arguments: {} } },
  { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"file_path":' } },
  { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: ' "/a.txt"' } },
  { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '}' } },
  { event_type: 'step.stop', index: 2 },
  {
    event_type: 'interaction.completed',
    interaction: {
      id: 'v1_int', status: 'requires_action',
      usage: { total_input_tokens: 11, total_cached_tokens: 0, total_output_tokens: 90, total_thought_tokens: 245, total_tokens: 346 },
    },
  },
];

function run(events: GeminiInteractionsEvent[]) {
  const acc = createGeminiInteractionsAccumulator();
  const live: StreamEvent[] = [];
  for (const ev of events) live.push(...acc.onEvent(ev));
  return { acc, live };
}

describe('createGeminiInteractionsAccumulator', () => {
  it('emits thinking_start, thinking, text live — in emission order — and nothing for lifecycle events', () => {
    const { live } = run(TOOL_ROUND);
    expect(live).toEqual([
      { kind: 'thinking_start' },
      { kind: 'thinking', text: 'I should read the file' },
      { kind: 'text', text: 'Let me ' },
      { kind: 'text', text: 'look.' },
    ]);
  });

  it('reassembles arguments_delta fragments into ONE parsed object, keyed by the provider id', () => {
    const { acc } = run(TOOL_ROUND);
    expect(acc.calls()).toEqual([{ id: 'fc_1', name: 'Read', input: { file_path: '/a.txt' } }]);
  });

  it("captures the turn's steps verbatim (the wire shape, deltas folded in); a clean tool round is stopReason null", () => {
    const { acc } = run(TOOL_ROUND);
    expect(acc.steps()).toEqual([
      { type: 'thought', signature: 'sig-A', summary: [{ type: 'text', text: 'I should read the file' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Let me look.' }] },
      { type: 'function_call', id: 'fc_1', name: 'Read', arguments: { file_path: '/a.txt' } },
    ]);
    expect(acc.final()).toEqual({
      stopReason: null,
      usage: { inputTokens: 11, outputTokens: 335, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 245 },
    });
  });

  it('captures EVERY round, signed thought or not — capture is never gated on a predicted shape', () => {
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'hi' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: { total_input_tokens: 1, total_output_tokens: 1 } } },
    ]);
    expect(acc.steps()).toEqual([{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }]);
    expect(acc.final()?.stopReason).toBeNull();
    // A stream with no step at all has nothing to replay.
    expect(run([{ event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: {} } }]).acc.steps()).toBeUndefined();
  });

  it('keeps what the old capture dropped: an UNSIGNED thought, a non-text output item, an unknown step type — in INDEX order', () => {
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'plan' } } },
      { event_type: 'step.start', index: 1, step: { type: 'google_search_call', id: 'gs_1', arguments: { queries: ['x'] } } },
      { event_type: 'step.start', index: 2, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 2, delta: { type: 'image', data: 'QQ', mime_type: 'image/png' } },
      { event_type: 'step.delta', index: 2, delta: { type: 'text', text: 'here' } },
      // Stops land out of order; the channel keeps the provider's index order.
      { event_type: 'step.stop', index: 2 },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: {} } },
    ]);
    expect(acc.steps()).toEqual([
      { type: 'thought', summary: [{ type: 'text', text: 'plan' }] },
      { type: 'google_search_call', id: 'gs_1', arguments: { queries: ['x'] } },
      { type: 'model_output', content: [{ type: 'image', data: 'QQ', mime_type: 'image/png' }, { type: 'text', text: 'here' }] },
    ]);
  });

  it('falls back to step.start arguments when no delta arrived; a malformed buffer yields {} with a warn, never a throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'a', name: 'X', arguments: { k: 1 } } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'b', name: 'Y', arguments: {} } },
      { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: '{"broken":' } },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'requires_action', usage: {} } },
    ]);
    expect(acc.calls()).toEqual([{ id: 'a', name: 'X', input: { k: 1 } }, { id: 'b', name: 'Y', input: {} }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('two parallel calls interleaved by index each keep their own buffer', () => {
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'a', name: 'X', arguments: {} } },
      { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'b', name: 'Y', arguments: {} } },
      { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: '{"b":' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"a":1}' } },
      { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: '2}' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'requires_action', usage: {} } },
    ]);
    expect(acc.calls()).toEqual([{ id: 'a', name: 'X', input: { a: 1 } }, { id: 'b', name: 'Y', input: { b: 2 } }]);
  });

  it('usage falls back to the last step.delta metadata.total_usage when interaction.completed carries none', () => {
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'x' }, metadata: { total_usage: { total_input_tokens: 7, total_output_tokens: 3 } } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed' } },
    ]);
    expect(acc.final()?.usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('a TOKEN-LESS terminal usage never shadows the delta fallback (the silent $0 turn)', () => {
    // `usage: {}` is a real shape (several of our own fixtures use it) and it is not
    // nullish, so a `??` fallback would keep it and bill the turn at zero.
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'x' }, metadata: { total_usage: { total_input_tokens: 7, total_output_tokens: 3 } } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: {} } },
    ]);
    expect(acc.final()?.usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('a SECOND interaction.completed without usage keeps the first terminal\'s token counts', () => {
    const { acc } = run([
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: { total_input_tokens: 5, total_output_tokens: 2 } } },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed' } },
    ]);
    expect(acc.final()?.usage).toEqual({ inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('closes still-open steps at interaction.completed (a stream that never sent step.stop)', () => {
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'partial' } },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'incomplete', usage: {} } },
    ]);
    expect(acc.final()?.stopReason).toBe('max_tokens');
  });

  it('the replay channel keeps the visible text closed at interaction.completed, never only the thought', () => {
    const { acc } = run([
      { event_type: 'step.start', index: 0, step: { type: 'thought', signature: 'sig-B' } },
      { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'the answer' } },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: {} } },
    ]);
    expect(acc.steps()).toEqual([
      { type: 'thought', signature: 'sig-B' },
      { type: 'model_output', content: [{ type: 'text', text: 'the answer' }] },
    ]);
  });

  it('maps statuses: incomplete/budget_exceeded → max_tokens, cancelled → aborted', () => {
    const at = (status: string) => run([{ event_type: 'interaction.completed', interaction: { id: 'i', status, usage: {} } }]).acc.final()?.stopReason;
    expect(at('budget_exceeded')).toBe('max_tokens');
    expect(at('cancelled')).toBe('aborted');
    expect(at('completed')).toBeNull();
    expect(at('idle')).toBeNull();
  });

  it('a blocked model_output (safety) is a refusal; any other step error throws with its code', () => {
    const blocked = run([
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [], error: { code: 'FAILED_PRECONDITION', message: 'Blocked by safety settings' } } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: {} } },
    ]);
    expect(blocked.acc.final()?.stopReason).toBe('refusal');

    const other = run([
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [], error: { code: 'INTERNAL', message: 'backend hiccup' } } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: {} } },
    ]);
    expect(() => other.acc.final()).toThrow(/backend hiccup/);
    try { other.acc.final(); } catch (e) { expect((e as { code?: string }).code).toBe('INTERNAL'); }
  });

  it('an in-stream error event THROWS with the code upper-cased (classifiable by the shared spec)', () => {
    const acc = createGeminiInteractionsAccumulator();
    let thrown: unknown;
    try {
      acc.onEvent({ event_type: 'error', error: { code: 'gateway_timeout', message: 'Deadline expired' } });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Deadline expired');
    expect((thrown as { code?: string }).code).toBe('GATEWAY_TIMEOUT');
  });

  it('a failed interaction throws from final() with the first error', () => {
    const { acc } = run([{ event_type: 'interaction.completed', interaction: { id: 'i', status: 'failed', errors: [{ code: 'internal', message: 'boom' }] } }]);
    expect(() => acc.final()).toThrow(/boom/);
  });

  it('no terminal event → final() is null (the severed-stream signal)', () => {
    const { acc } = run([{ event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } }]);
    expect(acc.final()).toBeNull();
  });

  it('unknown event and delta types are ignored, not thrown', () => {
    const { live, acc } = run([
      { event_type: 'interaction.frobnicated', anything: 1 },
      { event_type: 'step.start', index: 0, step: { type: 'google_search_call', id: 'g', arguments: {} } },
      { event_type: 'step.delta', index: 0, delta: { type: 'image', data: 'x' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: {} } },
    ]);
    expect(live).toEqual([]);
    expect(acc.calls()).toEqual([]);
    expect(acc.final()?.stopReason).toBeNull();
  });
});

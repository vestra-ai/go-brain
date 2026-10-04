import { describe, it, expect } from 'vitest';
import {
  ensureValidGeminiInteractionsSteps,
  stripOrphanedGeminiInteractionsCalls,
  GEMINI_SENTINEL_THOUGHT_SIGNATURE,
} from '../gemini-interactions-validity.js';
import type { GeminiInteractionsStep } from '../gemini-interactions-wire.js';

const user = (text: string): GeminiInteractionsStep => ({ type: 'user_input', content: [{ type: 'text', text }] });
const call = (id: string): GeminiInteractionsStep => ({ type: 'function_call', id, name: 'Read', arguments: { p: id } });
const result = (id: string, text = 'ok'): GeminiInteractionsStep => ({
  type: 'function_result', call_id: id, name: 'Read', result: [{ type: 'text', text }],
});

describe('ensureValidGeminiInteractionsSteps — the shared invariant set on the Interactions shape', () => {
  it('an empty user_input gets the (no content) placeholder; empty text items are dropped', () => {
    const out = ensureValidGeminiInteractionsSteps([
      { type: 'user_input', content: [{ type: 'text', text: '' }] },
      { type: 'user_input', content: [] },
    ]);
    // Both are user_input → merged into ONE, holding one placeholder.
    expect(out).toEqual([{ type: 'user_input', content: [{ type: 'text', text: '(no content)' }] }]);
  });

  it('an empty model_output is DROPPED; an empty function_result gets (no output)', () => {
    const out = ensureValidGeminiInteractionsSteps([
      user('q'),
      { type: 'model_output', content: [{ type: 'text', text: '' }] },
      call('fc_1'),
      { type: 'function_result', call_id: 'fc_1', name: 'Read', result: [] },
    ]);
    expect(out.map((s) => s.type)).toEqual(['user_input', 'thought', 'function_call', 'function_result']);
    expect(out[3]).toEqual({ type: 'function_result', call_id: 'fc_1', name: 'Read', result: [{ type: 'text', text: '(no output)' }] });
  });

  it('a placeholder never sits beside real content when an empty turn folds in', () => {
    const out = ensureValidGeminiInteractionsSteps([user('hello'), { type: 'user_input', content: [] }]);
    expect(out).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('consecutive user_input steps merge into one; images survive', () => {
    const out = ensureValidGeminiInteractionsSteps([
      { type: 'user_input', content: [{ type: 'image', data: 'AAAA', mime_type: 'image/png' }] },
      user('what is this'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: 'user_input',
      content: [{ type: 'image', data: 'AAAA', mime_type: 'image/png' }, { type: 'text', text: 'what is this' }],
    });
  });

  // VIDEO_UNDERSTANDING_V1 §7 — a media-only turn ("watch this" with the clip
  // attached and nothing typed) is a REAL turn: the floor must not paper it over
  // with `(no content)`, which would hide the video from the model.
  it('a user_input whose only content is a media item is NOT placeholdered', () => {
    const media = { type: 'video' as const, mime_type: 'video/mp4', uri: '' };
    expect(ensureValidGeminiInteractionsSteps([{ type: 'user_input', content: [media] }])).toEqual([
      { type: 'user_input', content: [media] },
    ]);
    // …and it still crowds out the placeholder when an empty turn folds into it.
    expect(
      ensureValidGeminiInteractionsSteps([
        { type: 'user_input', content: [media] },
        { type: 'user_input', content: [] },
      ]),
    ).toEqual([{ type: 'user_input', content: [media] }]);
  });

  it('thought and function_call steps pass through untouched (same reference)', () => {
    const thought: GeminiInteractionsStep = { type: 'thought', signature: 'sig' };
    const c = call('fc_1');
    const out = ensureValidGeminiInteractionsSteps([user('q'), thought, c, result('fc_1')]);
    expect(out[1]).toBe(thought);
    expect(out[2]).toBe(c);
  });
});

describe('stripOrphanedGeminiInteractionsCalls — pairing by call_id at the whole-history seam', () => {
  it('an unanswered function_call gets a synthesized (no output) result right after its call run', () => {
    const out = stripOrphanedGeminiInteractionsCalls([user('q'), call('fc_1'), call('fc_2'), result('fc_1'), user('next')]);
    expect(out.map((s) => (s.type === 'function_result' ? `res:${s.call_id}` : s.type === 'function_call' ? `call:${s.id}` : s.type)))
      .toEqual(['user_input', 'call:fc_1', 'call:fc_2', 'res:fc_2', 'res:fc_1', 'user_input']);
    const synth = out[3] as Extract<GeminiInteractionsStep, { type: 'function_result' }>;
    expect(synth.result).toEqual([{ type: 'text', text: '(no output)' }]);
    expect(synth.name).toBe('Read');
  });

  it('a function_result with no matching call is DROPPED', () => {
    const out = stripOrphanedGeminiInteractionsCalls([user('q'), result('ghost'), call('fc_1'), result('fc_1')]);
    expect(out.map((s) => s.type)).toEqual(['user_input', 'function_call', 'function_result']);
  });

  it('a fully-paired history is returned unchanged (same references)', () => {
    const steps = [user('q'), call('fc_1'), result('fc_1')];
    const out = stripOrphanedGeminiInteractionsCalls(steps);
    expect(out).toEqual(steps);
    // ARRAY identity, not just element identity: the whole-history contract is that a
    // clean history costs nothing. Rebuilding a fresh array of the same elements would
    // satisfy toEqual and the element check below, so only this pins the early return.
    expect(out).toBe(steps);
    expect(out[1]).toBe(steps[1]);
  });

  it('a trailing unanswered call at the END of history is answered too', () => {
    const out = stripOrphanedGeminiInteractionsCalls([user('q'), call('fc_1')]);
    expect(out.map((s) => s.type)).toEqual(['user_input', 'function_call', 'function_result']);
  });
});

describe('ensureValidGeminiInteractionsSteps — a model turn that calls a function opens with a thought', () => {
  // Google 400s a bare function_call on stateless replay (probed 2026-09-04) and
  // documents a sentinel signature for calls it did not sign. These are its pins.
  const sentinel = { type: 'thought', signature: GEMINI_SENTINEL_THOUGHT_SIGNATURE };

  it('a bare call run gets ONE sentinel before its FIRST call, none before the rest', () => {
    const out = ensureValidGeminiInteractionsSteps([user('q'), call('fc_1'), call('fc_2'), result('fc_1'), result('fc_2')]);
    expect(out.map((s) => s.type)).toEqual(['user_input', 'thought', 'function_call', 'function_call', 'function_result', 'function_result']);
    expect(out[1]).toEqual(sentinel);
  });

  it('a call run that already opens with a signed thought is untouched — the real signature is never replaced', () => {
    const thought: GeminiInteractionsStep = { type: 'thought', signature: 'real-sig' };
    const steps = [user('q'), thought, call('fc_1'), result('fc_1')];
    const out = ensureValidGeminiInteractionsSteps(steps);
    expect(out).toHaveLength(4);
    expect(out[1]).toBe(thought);
    expect(JSON.stringify(out)).not.toContain(GEMINI_SENTINEL_THOUGHT_SIGNATURE);
  });

  it('a turn that speaks before it calls gets the sentinel at its HEAD, ahead of the text — Google 400s a thought after text', () => {
    // The live handoff shape (staging task 74fc3af1, 2026-09-04): DeepSeek's turn
    // "Reading the hostname." + Bash call, replayed into Gemini.
    const out = ensureValidGeminiInteractionsSteps([
      user('q'), { type: 'model_output', content: [{ type: 'text', text: 'Let me read it.' }] }, call('fc_1'), result('fc_1'),
    ]);
    expect(out.map((s) => s.type)).toEqual(['user_input', 'thought', 'model_output', 'function_call', 'function_result']);
    expect(out[1]).toEqual(sentinel);
  });

  it('the head is the head of THIS turn: a second bare turn gets its sentinel after the first turn\'s result, not at the history start', () => {
    const out = ensureValidGeminiInteractionsSteps([
      user('q'),
      { type: 'model_output', content: [{ type: 'text', text: 'first' }] }, call('fc_1'), result('fc_1'),
      { type: 'model_output', content: [{ type: 'text', text: 'second' }] }, call('fc_2'), result('fc_2'),
    ]);
    expect(out.map((s) => s.type)).toEqual([
      'user_input', 'thought', 'model_output', 'function_call', 'function_result',
      'thought', 'model_output', 'function_call', 'function_result',
    ]);
  });

  it('every model turn is judged on its own: a function_result ends the turn, so the next bare run gets its own sentinel', () => {
    const out = ensureValidGeminiInteractionsSteps([user('q'), call('fc_1'), result('fc_1'), call('fc_2'), result('fc_2')]);
    expect(out.filter((s) => s.type === 'thought')).toHaveLength(2);
    expect(out.map((s) => s.type)).toEqual(['user_input', 'thought', 'function_call', 'function_result', 'thought', 'function_call', 'function_result']);
  });

  it('idempotent: the per-slice pass and the whole-history pass together insert exactly one', () => {
    const once = ensureValidGeminiInteractionsSteps([user('q'), call('fc_1'), result('fc_1')]);
    expect(ensureValidGeminiInteractionsSteps(once)).toEqual(once);
  });

  it('a turn with no function call gets no sentinel (a text-only history is byte-identical)', () => {
    const steps: GeminiInteractionsStep[] = [user('q'), { type: 'model_output', content: [{ type: 'text', text: 'hi' }] }];
    expect(ensureValidGeminiInteractionsSteps(steps)).toEqual(steps);
  });
});

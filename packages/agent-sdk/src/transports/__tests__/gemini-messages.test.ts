import { describe, it, expect } from 'vitest';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import {
  journalToGeminiContents,
  createGeminiAccumulator,
  type GeminiStreamChunk,
} from '../gemini-messages.js';

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`,
    parentUuid: seq === 1 ? null : `u${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-06-26T00:00:00.000Z',
    payload,
  };
}

describe('journalToGeminiContents', () => {
  it('projects roles (user/model), folds functionCall, names functionResponse by call', () => {
    seq = 0;
    const contents = journalToGeminiContents([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'weather?' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'checking' }] }),
      entry({ type: 'tool_use', toolUseId: 'x1', name: 'getWeather', input: { city: 'SF' } }),
      entry({ type: 'tool_result', toolUseId: 'x1', blocks: [{ type: 'text', text: 'sunny' }] }),
    ]);

    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'weather?' }] });
    // model turn carries text + the folded functionCall
    expect(contents[1].role).toBe('model');
    expect(contents[1].parts).toEqual([
      { text: 'checking' },
      // An old journal carries no signature: the floor gives the call the sentinel.
      { functionCall: { name: 'getWeather', args: { city: 'SF' } }, thoughtSignature: 'skip_thought_signature_validator' },
    ]);
    // tool result becomes a user turn with a functionResponse named after the call
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'getWeather', response: { output: 'sunny' } } }],
    });
  });

  it('applies the floor: an empty tool result functionResponse gets a placeholder', () => {
    seq = 0;
    const contents = journalToGeminiContents([
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'tool_use', toolUseId: 'x2', name: 'noop', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'x2', blocks: [] }),
    ]);
    const fr = contents.find((c) => c.parts[0]?.functionResponse)?.parts[0].functionResponse;
    expect(fr?.response).toEqual({ output: '(no output)' });
  });
});

describe('createGeminiAccumulator', () => {
  function chunk(c: GeminiStreamChunk): GeminiStreamChunk {
    return c;
  }

  it('accumulates text, a functionCall, and usage; separates thought parts', () => {
    const acc = createGeminiAccumulator();
    const c1 = chunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] });
    const c2 = chunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'planning', thought: true }] } }] });
    const c3 = chunk({
      candidates: [{ content: { parts: [{ functionCall: { name: 'fn', args: { a: 1 } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
    });
    for (const c of [c1, c2, c3]) acc.onChunk(c);

    expect(acc.textDelta(c1)).toBe('Hel');
    expect(acc.thinkingDelta(c2)).toBe('planning');
    expect(acc.textDelta(c2)).toBeNull(); // thought parts are not visible text
    const calls = acc.toolUses();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'fn', input: { a: 1 } });
    // The internal id is a globally-unique UUID (never a per-stream counter), so it
    // cannot collide across turns and poison keepLastToolResultPerId.
    expect(calls[0].id).toMatch(/^gemini-call-[0-9a-f-]{36}$/);
    expect(acc.final()).toMatchObject({ stopReason: 'STOP', usage: { inputTokens: 12, outputTokens: 4 } });
  });

  it('mints NON-COLLIDING ids across two sequential streams (the keepLastToolResultPerId fix)', () => {
    // Each stream gets a fresh accumulator; a per-stream counter restarted at 0, so
    // turn-1 and turn-2 both minted `gemini-call-0` → the kernel journal collapsed
    // them. UUID ids are unique across streams.
    const mkCall = () => {
      const acc = createGeminiAccumulator();
      acc.onChunk({ candidates: [{ content: { parts: [{ functionCall: { name: 'fn', args: {} } }] }, finishReason: 'STOP' }] });
      return acc.toolUses()[0].id;
    };
    expect(mkCall()).not.toBe(mkCall());
  });

  it('returns null final() with no terminal chunk', () => {
    const acc = createGeminiAccumulator();
    acc.onChunk({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] });
    expect(acc.final()).toBeNull();
  });
});

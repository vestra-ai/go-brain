import { describe, it, expect } from 'vitest';
import { createGeminiAccumulator, journalToGeminiContents } from '../gemini-messages.js';
import type { GeminiStreamChunk } from '../gemini-messages.js';
import type { JournalEntry } from '../../contract/journal.js';

/**
 * PR6 (Hermes parity) — Gemini-3 `thoughtSignature` capture/replay. Gemini-3 thinking
 * models attach an opaque `thoughtSignature` to each tool call (functionCall part) and
 * 400 if it's MISSING on the next request — so tools die after round 1 unless we
 * capture it, persist it on the tool_use journal entry, and re-emit it on the
 * functionCall. Mirrors Hermes' `gemini_native_adapter.py` capture/attach/replay.
 */

function entry(seq: number, payload: JournalEntry['payload']): JournalEntry {
  return {
    uuid: `u${seq}`, parentUuid: seq === 0 ? null : `u${seq - 1}`, seq,
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
    agentId: 'native', principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-06-26T00:00:00.000Z', payload,
  };
}

describe('Gemini thoughtSignature — capture', () => {
  it('captures part.thoughtSignature off a functionCall chunk', () => {
    const acc = createGeminiAccumulator();
    const chunk: GeminiStreamChunk = {
      candidates: [{
        content: { parts: [{ functionCall: { name: 'Read', args: { p: 1 } }, thoughtSignature: 'SIG_ABC' } as never] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
    acc.onChunk(chunk);
    const calls = acc.toolUses();
    expect(calls).toHaveLength(1);
    expect(calls[0].thoughtSignature).toBe('SIG_ABC');
  });

  it('leaves thoughtSignature undefined when the part has none (non-Gemini-3)', () => {
    const acc = createGeminiAccumulator();
    acc.onChunk({ candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: {} } }] }, finishReason: 'STOP' }] });
    expect(acc.toolUses()[0].thoughtSignature).toBeUndefined();
  });
});

describe('Gemini thoughtSignature — replay', () => {
  it('re-emits thoughtSignature on the functionCall part from the tool_use journal entry', () => {
    const entries: JournalEntry[] = [
      entry(0, { type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry(1, { type: 'assistant', blocks: [] }),
      entry(2, { type: 'tool_use', toolUseId: 'c1', name: 'Read', input: { p: 1 }, thoughtSignature: 'SIG_ABC' }),
      entry(3, { type: 'tool_result', toolUseId: 'c1', blocks: [{ type: 'text', text: 'ok' }] }),
    ];
    const contents = journalToGeminiContents(entries);
    const modelTurn = contents.find((c) => c.role === 'model' && c.parts.some((p) => p.functionCall))!;
    const fcPart = modelTurn.parts.find((p) => p.functionCall) as Record<string, unknown>;
    expect(fcPart.thoughtSignature).toBe('SIG_ABC');
    expect((fcPart.functionCall as { name: string }).name).toBe('Read');
  });

  it('an entry with no signature (an old journal) gets the documented sentinel, never a bare call', () => {
    const entries: JournalEntry[] = [
      entry(0, { type: 'tool_use', toolUseId: 'c1', name: 'Read', input: {} }),
      // P2.0b: paired so the orphan-strip leaves the call under test.
      entry(1, { type: 'tool_result', toolUseId: 'c1', blocks: [{ type: 'text', text: 'ok' } as never] }),
    ];
    const contents = journalToGeminiContents(entries);
    const fcPart = contents[0].parts.find((p) => p.functionCall) as Record<string, unknown>;
    expect(fcPart.thoughtSignature).toBe('skip_thought_signature_validator');
  });
});

import { describe, it, expect } from 'vitest';
import { detectConvoCorrection, REPAIR_MARKERS } from '../convo-correction.js';
import type { JournalBlock } from '../episode.js';

describe('detectConvoCorrection', () => {
  it('fires on a free-text correction that follows a substantive agent action', () => {
    const blocks: JournalBlock[] = [
      { kind: 'assistant', text: 'Atlas ships March 1' },
      { kind: 'user', text: 'no, it moved to March 15' },
    ];
    const result = detectConvoCorrection(blocks);
    expect(result.hit).toBe(true);
    expect(result.matched).toContain('no');
  });

  it('does NOT fire on a bare opener in the first block (no preceding action)', () => {
    const blocks: JournalBlock[] = [{ kind: 'user', text: 'no rush, take your time' }];
    const result = detectConvoCorrection(blocks);
    expect(result.hit).toBe(false);
    expect(result.matched).toEqual([]);
  });

  it('does NOT fire when the marked user turn precedes any substantive action', () => {
    const blocks: JournalBlock[] = [
      { kind: 'user', text: 'no rush' },
      { kind: 'assistant', text: 'understood' },
    ];
    expect(detectConvoCorrection(blocks).hit).toBe(false);
  });

  it('fires after a tool_use / tool_result chain, not only after assistant text', () => {
    const blocks: JournalBlock[] = [
      { kind: 'tool_use', text: 'search(query="atlas date")' },
      { kind: 'tool_result', text: 'March 1' },
      { kind: 'user', text: "actually that's not right" },
    ];
    const result = detectConvoCorrection(blocks);
    expect(result.hit).toBe(true);
    expect(result.matched).toContain('actually');
  });

  it('only inspects user blocks, never markers in assistant text', () => {
    const blocks: JournalBlock[] = [
      { kind: 'assistant', text: 'I was wrong, actually it should be March 15' },
      { kind: 'user', text: 'thanks, looks good' },
    ];
    expect(detectConvoCorrection(blocks).hit).toBe(false);
  });

  it('returns the unique matched markers, deduped', () => {
    const blocks: JournalBlock[] = [
      { kind: 'assistant', text: 'shipped' },
      { kind: 'user', text: 'no, no, actually I meant the other one' },
    ];
    const result = detectConvoCorrection(blocks);
    expect(result.hit).toBe(true);
    expect([...result.matched].sort()).toEqual(['actually', 'i meant', 'no']);
  });

  it('respects word boundaries (nope/cannot/notice/another do not fire)', () => {
    const blocks: JournalBlock[] = [
      { kind: 'assistant', text: 'done' },
      { kind: 'user', text: 'nope cannot notice another' },
    ];
    expect(detectConvoCorrection(blocks).hit).toBe(false);
  });

  it('exposes the repair-marker regex set', () => {
    expect(REPAIR_MARKERS.length).toBeGreaterThan(0);
    expect(REPAIR_MARKERS.every((r) => r instanceof RegExp)).toBe(true);
  });
});

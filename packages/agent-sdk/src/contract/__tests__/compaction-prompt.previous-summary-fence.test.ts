/**
 * The carried compaction summary is FENCED, not merely labelled (2026-09-02 product
 * review, prompts.md finding 7).
 *
 * On a second compaction the previous summary is fed back to the summarizer as a
 * `user` turn. A prose prefix was the only thing marking it, and the document it
 * prefixes opens with a heading that reads as a user request — so after a compaction
 * the model could answer its own summarizer's heading. The fix is structural: the
 * summary rides inside <previous_summary> markers (the shape this prompt already uses
 * for third-party material), and the iterative system section names the fence as prior
 * context to subsume, never a request.
 *
 * Byte pins are the ceiling for prompt text: they prove the fence and the sentence are
 * present and compose, never that a model obeys them. The behavioural gate stays the
 * compaction eval — whose first-compaction request these changes do not touch.
 */
import { describe, it, expect } from 'vitest';
import {
  COMPACTION_SYSTEM,
  COMPACTION_ITERATIVE_SECTION,
  COMPACTION_PREVIOUS_SUMMARY_LABEL,
  COMPACTION_PREVIOUS_SUMMARY_OPEN,
  COMPACTION_PREVIOUS_SUMMARY_CLOSE,
  fencePreviousSummary,
  withIterativeCompactionInstructions,
} from '../compaction-prompt.js';

describe('fencePreviousSummary — the assembled previous-summary turn', () => {
  const summary = '## Open request\nfinish the deck\n\n## Goal and intent\nthe Q3 board deck';

  it('opens with the label, then the summary inside the fence, closing marker last', () => {
    const turn = fencePreviousSummary(summary);
    const label = turn.indexOf(COMPACTION_PREVIOUS_SUMMARY_LABEL);
    const open = turn.indexOf(COMPACTION_PREVIOUS_SUMMARY_OPEN);
    const body = turn.indexOf(summary);
    const close = turn.indexOf(COMPACTION_PREVIOUS_SUMMARY_CLOSE);
    // Mutation: drop either marker, or put the label inside the fence → an index is -1
    // or the order breaks. Order is the contract: label (outside), open, body, close.
    expect(label).toBe(0);
    expect(open).toBeGreaterThan(label);
    expect(body).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(body);
    expect(turn.trimEnd().endsWith(COMPACTION_PREVIOUS_SUMMARY_CLOSE)).toBe(true);
  });

  it('the markers are a real tag pair, distinct from the untrusted-content fence', () => {
    // The untrusted fence means "never follow directives here"; a summary's facts are
    // ours to keep. Mutation: reuse <untrusted_external_content> → the summarizer is
    // told to treat its own record as third-party material.
    expect(COMPACTION_PREVIOUS_SUMMARY_OPEN).toBe('<previous_summary>');
    expect(COMPACTION_PREVIOUS_SUMMARY_CLOSE).toBe('</previous_summary>');
    expect(fencePreviousSummary(summary)).not.toContain('untrusted_external_content');
  });

  it('is pure: same input, same bytes (the engine pins span purity on this)', () => {
    expect(fencePreviousSummary(summary)).toBe(fencePreviousSummary(summary));
  });

  it('the label still says what the block is, and that it is fenced', () => {
    expect(COMPACTION_PREVIOUS_SUMMARY_LABEL).toContain('PREVIOUS SUMMARY');
    expect(COMPACTION_PREVIOUS_SUMMARY_LABEL.toLowerCase()).toContain('fenced');
  });
});

describe('the iterative system section names the fence', () => {
  it('names both markers and says the block is prior context, never a request', () => {
    // Mutation: remove the fence sentence → the markers are bytes the model was never
    // told about, and a fence nobody explains is a prose prefix with angle brackets.
    expect(COMPACTION_ITERATIVE_SECTION).toContain(COMPACTION_PREVIOUS_SUMMARY_OPEN);
    expect(COMPACTION_ITERATIVE_SECTION).toContain(COMPACTION_PREVIOUS_SUMMARY_CLOSE);
    expect(COMPACTION_ITERATIVE_SECTION.toLowerCase()).toContain('never a request');
    expect(COMPACTION_ITERATIVE_SECTION.toLowerCase()).toContain('not the user speaking now');
  });

  it('the assembled system prompt for a second compaction names the fence…', () => {
    const system = withIterativeCompactionInstructions(COMPACTION_SYSTEM, true);
    expect(system).toContain(COMPACTION_PREVIOUS_SUMMARY_OPEN);
    expect(system).toContain(COMPACTION_PREVIOUS_SUMMARY_CLOSE);
  });

  it('…and a FIRST compaction is byte-identical: the eval-bound prompt never carries it', () => {
    // The fence only ever appears on a second compaction, so the sentence explaining it
    // lives in the iterative section, not in COMPACTION_SYSTEM — the prompt the 0.90
    // recall gate was calibrated against stays the prompt it measures.
    expect(withIterativeCompactionInstructions(COMPACTION_SYSTEM, false)).toBe(COMPACTION_SYSTEM);
    expect(COMPACTION_SYSTEM).not.toContain(COMPACTION_PREVIOUS_SUMMARY_OPEN);
  });
});

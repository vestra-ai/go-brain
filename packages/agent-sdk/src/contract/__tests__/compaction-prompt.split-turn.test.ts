/**
 * T9b — the pure split-turn instruction appender.
 *
 * When the compaction cut lands INSIDE a turn (the boundary rule now allows an
 * `assistant` cut, which is what lets a one-ask agentic loop compact at all), the
 * span being summarized is that turn's PREFIX and the turn's recent work is retained
 * verbatim AFTER the summary. pi hands that case its own instruction
 * (`TURN_PREFIX_SUMMARIZATION_PROMPT`, compaction.ts:835); our schema has ONE
 * summaryText, so the meaning is carried as a system-prompt section instead.
 *
 * PURE + TOTAL, exactly like `withIterativeCompactionInstructions`: `false` returns
 * the system UNCHANGED, so every non-split compaction stays byte-identical and the
 * compaction-eval still measures the prompt it was calibrated against.
 */
import { describe, it, expect } from 'vitest';
import {
  COMPACTION_SYSTEM,
  COMPACTION_SPLIT_TURN_SECTION,
  withSplitTurnInstructions,
} from '../compaction-prompt.js';

describe('withSplitTurnInstructions', () => {
  it('returns the system UNCHANGED when the cut did not split a turn (byte-identical)', () => {
    expect(withSplitTurnInstructions(COMPACTION_SYSTEM, false)).toBe(COMPACTION_SYSTEM);
  });

  it('appends the split-turn section AFTER the base system when the cut split a turn', () => {
    const out = withSplitTurnInstructions(COMPACTION_SYSTEM, true);
    expect(out.startsWith(COMPACTION_SYSTEM)).toBe(true);
    expect(out).toContain(COMPACTION_SPLIT_TURN_SECTION);
  });

  it('carries pi\'s meaning: the retained suffix is NOT finished work', () => {
    // The three claims the section has to make, or the model writes a summary that
    // reads as a completed turn and the retained rounds become unexplained.
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('prefix');
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('retained');
    expect(COMPACTION_SPLIT_TURN_SECTION.toLowerCase()).toContain('not describe');
  });

  it('composes with the iterative section without either swallowing the other', () => {
    const both = withSplitTurnInstructions(
      `${COMPACTION_SYSTEM}\n\nITERATIVE-MARKER`,
      true,
    );
    expect(both).toContain('ITERATIVE-MARKER');
    expect(both).toContain(COMPACTION_SPLIT_TURN_SECTION);
    expect(both.indexOf('ITERATIVE-MARKER')).toBeLessThan(both.indexOf(COMPACTION_SPLIT_TURN_SECTION));
  });
});

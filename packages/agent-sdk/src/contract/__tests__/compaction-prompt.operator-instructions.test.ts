/**
 * UNIT A — the pure operator-instructions appender used by the PreCompact seam.
 *
 * `withOperatorCompactionInstructions(system, instructions)` appends a bounded,
 * clearly-labelled operator section to the compaction system prompt. Absent/blank
 * instructions → the system is returned unchanged (byte-identical); present →
 * appended under a label; over-cap → truncated to COMPACTION_OPERATOR_INSTRUCTIONS_MAX.
 */
import { describe, it, expect } from 'vitest';
import {
  COMPACTION_SYSTEM,
  COMPACTION_OPERATOR_INSTRUCTIONS_MAX,
  withOperatorCompactionInstructions,
} from '../compaction-prompt.js';

describe('withOperatorCompactionInstructions', () => {
  it('returns the system UNCHANGED when instructions are undefined (byte-identical)', () => {
    expect(withOperatorCompactionInstructions(COMPACTION_SYSTEM, undefined)).toBe(COMPACTION_SYSTEM);
  });

  it('returns the system UNCHANGED when instructions are blank/whitespace', () => {
    expect(withOperatorCompactionInstructions(COMPACTION_SYSTEM, '   \n\t ')).toBe(COMPACTION_SYSTEM);
  });

  it('appends a labelled operator section AFTER the base system', () => {
    const out = withOperatorCompactionInstructions(COMPACTION_SYSTEM, 'Preserve all ticket ids.');
    expect(out.startsWith(COMPACTION_SYSTEM)).toBe(true);
    expect(out).toContain('Additional instructions from the operator:');
    expect(out).toContain('Preserve all ticket ids.');
    expect(out.indexOf('Additional instructions from the operator:')).toBeGreaterThan(
      out.indexOf(COMPACTION_SYSTEM),
    );
  });

  it('trims surrounding whitespace on the instructions before appending', () => {
    const out = withOperatorCompactionInstructions(COMPACTION_SYSTEM, '   keep the URLs   ');
    expect(out).toContain('keep the URLs');
    expect(out).not.toContain('keep the URLs   ');
  });

  it('truncates over-cap instructions to COMPACTION_OPERATOR_INSTRUCTIONS_MAX chars', () => {
    const huge = 'X'.repeat(COMPACTION_OPERATOR_INSTRUCTIONS_MAX + 250) + 'DROP_ME';
    const out = withOperatorCompactionInstructions(COMPACTION_SYSTEM, huge);
    expect(out).not.toContain('DROP_ME');
    const appended = out.slice(out.indexOf('Additional instructions from the operator:'));
    // The appended body (past the label + newline) never exceeds the cap.
    const body = appended.replace(/^Additional instructions from the operator:\s*/, '');
    expect(body.length).toBeLessThanOrEqual(COMPACTION_OPERATOR_INSTRUCTIONS_MAX);
  });

  it('keeps an exactly-cap-length instruction intact (no off-by-one truncation)', () => {
    const exact = 'Y'.repeat(COMPACTION_OPERATOR_INSTRUCTIONS_MAX);
    const out = withOperatorCompactionInstructions(COMPACTION_SYSTEM, exact);
    expect(out).toContain(exact);
  });
});

import { describe, expect, it } from 'vitest';
import { ReflexEnv } from '../env.js';
import { PASSED_SETS } from '../live-gate.js';

describe('the G5 live gate', () => {
  it('keeps question 8 live: it can only add caution, and the cut line never drops it', () => {
    expect(PASSED_SETS).toContain(8);
  });

  it('makes the default live list exactly the questions that passed', () => {
    expect(ReflexEnv.parse({}).REFLEX_LIVE).toBe([...PASSED_SETS].sort((a, b) => a - b).map((n) => `q${n}`).join(','));
  });
});

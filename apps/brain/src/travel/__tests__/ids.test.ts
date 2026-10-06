import { describe, expect, it } from 'vitest';
import { mintId, stableId } from '../ids.js';

describe('ids', () => {
  it('mints fresh ids with the prefix, short enough for a contract Id', () => {
    const a = mintId('gt');
    const b = mintId('gt');
    expect(a).toMatch(/^gt_[0-9a-z]{20}$/);
    expect(a).not.toBe(b);
  });

  it('gives the same id for the same parts and a different one for different parts', () => {
    expect(stableId('c_opt', 'turn_1', 'r_1', '1,2,3')).toBe(stableId('c_opt', 'turn_1', 'r_1', '1,2,3'));
    expect(stableId('c_opt', 'turn_1', 'r_1', '1,2,3')).not.toBe(stableId('c_opt', 'turn_2', 'r_1', '1,2,3'));
    expect(stableId('go', 'a', 'bc')).not.toBe(stableId('go', 'ab', 'c'));
    expect(stableId('go', 'x').length).toBeLessThanOrEqual(64);
  });
});

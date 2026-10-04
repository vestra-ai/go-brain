/**
 * Orchestration walls (spec §4.2) — a NESTED batch partitions exactly like the main loop.
 *
 * RED pin (pre-wall): `partitionToolBatch` returned ONE sequential segment for every
 * nested batch, so a helper's parallel fan-out ran one child at a time no matter how
 * many siblings it launched. The `nestedConcurrent` option lifts that rule; absent it,
 * the historic single-sequential-segment shape is byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { partitionToolBatch } from '../batch-shape.js';

const A = (n: number) => Array.from({ length: n }, (_, i) => ({ name: 'Agent', id: `a${i}` }));

describe('partitionToolBatch — nested batches partition under the walls', () => {
  it('flag-off: a nested batch is one sequential segment', () => {
    expect(partitionToolBatch(A(3), false)).toEqual([{ concurrent: false, tus: A(3) }]);
  });
  it('walls: a nested ≥2 Agent run is a concurrent segment, exactly like the main loop', () => {
    expect(partitionToolBatch(A(3), false, () => false, { nestedConcurrent: true })).toEqual([{ concurrent: true, tus: A(3) }]);
    expect(partitionToolBatch([{ name: 'Read', id: 'r' }, ...A(2)], false, () => false, { nestedConcurrent: true })).toEqual([
      { concurrent: false, tus: [{ name: 'Read', id: 'r' }] },
      { concurrent: true, tus: A(2) },
    ]);
  });
});

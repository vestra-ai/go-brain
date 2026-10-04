import { describe, it, expect } from 'vitest';
import { reconcileChildUsage, type ChildCostRecord } from '../child-cost.js';

const rec = (id: string, costUsd: number): ChildCostRecord => ({
  childId: id, model: 'claude-opus-4-8', usage: { inputTokens: 1, outputTokens: 1 } as any, costUsd,
});

describe('reconcileChildUsage', () => {
  it('sums own-costs plus the parent own-cost to the authoritative total', () => {
    const total = reconcileChildUsage([rec('a', 0.10), rec('b', 0.05)], 0.02);
    expect(total).toBeCloseTo(0.17, 9);
  });
  it('is identity (parent own-cost) when there are no children', () => {
    expect(reconcileChildUsage([], 0.03)).toBeCloseTo(0.03, 9);
  });
});

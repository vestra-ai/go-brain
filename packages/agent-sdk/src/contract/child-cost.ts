import type { NormalizedUsage } from './events.js';

export interface ChildCostRecord {
  childId: string;
  parentChildId?: string;
  subagentType?: string;
  model: string;
  usage: NormalizedUsage;
  costUsd: number; // this node's OWN model-round cost (NOT inclusive of its children)
}

/** Sum of every node's own-cost. By construction equals the turn's cumulativeCostUsd. */
export function reconcileChildUsage(records: ChildCostRecord[], parentOwnCostUsd: number): number {
  return records.reduce((acc, r) => acc + r.costUsd, parentOwnCostUsd);
}

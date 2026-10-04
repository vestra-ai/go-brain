import { describe, it, expect } from 'vitest';
import { createRunContext } from '../run-context.js';

describe('createRunContext', () => {
  it('seeds billing from initialCostUsd (the warm-resume path)', () => {
    const rc = createRunContext('task-1', 1.25);
    expect(rc.billing.cumulativeCostUsd).toBe(1.25);
    expect(rc.billing.parentOwnCostUsd).toBe(0);
    expect(rc.billing.childUsage).toEqual([]);
    expect(rc.billing.roundCounter.value).toBe(0);
  });
  it('defaults to $0 like the cold path (ctx.config.initialCostUsd ?? 0)', () => {
    expect(createRunContext('task-1').billing.cumulativeCostUsd).toBe(0);
  });
  it('ownerTaskId defaults to taskId at depth 0', () => {
    expect(createRunContext('t').ownerTaskId).toBe('t');
  });
});

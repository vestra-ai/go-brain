/**
 * Focused unit coverage for the extracted billing-tripwire pure functions
 * (billing-tripwire.ts). The end-to-end journal + raw-event promotion is covered by
 * native-harness.billing-tripwire.test.ts; here we pin the pure check + payload shape.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  checkTurnBillingTripwire,
  buildBillingTripwirePayload,
  BILLING_TRIPWIRE_EVENT,
} from '../billing-tripwire.js';
import type { ChildCostRecord } from '../../contract/child-cost.js';

const child = (costUsd: number): ChildCostRecord => ({
  childId: `c-${costUsd}`,
  model: 'child',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd,
});

describe('checkTurnBillingTripwire', () => {
  it('returns null on a clean turn (reconcile holds, positive spend)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const v = checkTurnBillingTripwire({ turnDeltaUsd: 0.05, parentOwnCostUsd: 0.05, childUsage: [] }, true);
      expect(v).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('flags reconcile_drift when parentOwn + Σchild != turnDelta, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // parentOwn 0.03 + child 0.05 = 0.08 expected, but turnDelta only 0.03.
      const v = checkTurnBillingTripwire({ turnDeltaUsd: 0.03, parentOwnCostUsd: 0.03, childUsage: [child(0.05)] }, true);
      expect(v).toEqual({ reason: 'reconcile_drift', expected: 0.08, actual: 0.03, delta: 0.05 });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('reconcile drift'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('flags zero_spend only when a model call was expected (expectPositiveSpend)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // reconcile holds (0 === 0) but a completed turn made ≥1 call yet billed 0.
      const flagged = checkTurnBillingTripwire({ turnDeltaUsd: 0, parentOwnCostUsd: 0, childUsage: [] }, true);
      expect(flagged?.reason).toBe('zero_spend');
      // With expectPositiveSpend false (aborted/paused turn), a 0 delta is legitimate.
      const ok = checkTurnBillingTripwire({ turnDeltaUsd: 0, parentOwnCostUsd: 0, childUsage: [] }, false);
      expect(ok).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('tolerates float noise within EPS (no false drift)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const v = checkTurnBillingTripwire({ turnDeltaUsd: 0.1, parentOwnCostUsd: 0.1 + 1e-9, childUsage: [] }, true);
      expect(v).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('buildBillingTripwirePayload', () => {
  it('carries the violation figures + the run identity', () => {
    const payload = buildBillingTripwirePayload(
      { reason: 'reconcile_drift', expected: 0.08, actual: 0.03, delta: 0.05 },
      'task-1',
      'run-1',
      7,
    );
    expect(payload).toEqual({
      reason: 'reconcile_drift',
      expected: 0.08,
      actual: 0.03,
      delta: 0.05,
      taskId: 'task-1',
      runId: 'run-1',
      round: 7,
    });
  });
});

describe('BILLING_TRIPWIRE_EVENT', () => {
  it('is the agent-namespaced anomaly event name', () => {
    expect(BILLING_TRIPWIRE_EVENT).toBe('agent:billing_tripwire');
  });
});

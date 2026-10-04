import { describe, it, expect } from 'vitest';
import type { NormalizedUsage } from '../events.js';

/**
 * §4.2 two-type trap + §4.9 orchestration attribution.
 *
 * The SUMMED `orchestrationTokens?` (billing term, read by computeFuguCostUsd) was
 * added to BOTH NormalizedUsage shapes by PRICE-1; DATA-5 adds the THREE DISCRETE
 * sub-fields (`orchestrationInputTokens?` / `orchestrationInputCachedTokens?` /
 * `orchestrationOutputTokens?`) to the CONTRACT NormalizedUsage for attribution —
 * these ride snake_case on the AGENT_USAGE wire (DATA-7) into the task_turn_usage
 * orchestration_* columns (DATA-2/DATA-10). All four are additive/optional: a
 * non-Fugu usage object leaves every one undefined ⇒ byte-identical.
 */
describe('contract NormalizedUsage orchestration fields', () => {
  it('carries the summed orchestrationTokens (PRICE-1 billing term)', () => {
    const u: NormalizedUsage = { inputTokens: 1, outputTokens: 2, orchestrationTokens: 7 };
    expect(u.orchestrationTokens).toBe(7);
  });

  it('accepts the discrete orchestration sub-fields (DATA-5 attribution)', () => {
    const u: NormalizedUsage = {
      inputTokens: 1,
      outputTokens: 2,
      orchestrationInputTokens: 4,
      orchestrationInputCachedTokens: 1,
      orchestrationOutputTokens: 9,
    };
    expect(u.orchestrationInputTokens).toBe(4);
    expect(u.orchestrationInputCachedTokens).toBe(1);
    expect(u.orchestrationOutputTokens).toBe(9);
  });

  it('stays valid when every orchestration field is omitted (non-Fugu byte-identical)', () => {
    const u: NormalizedUsage = { inputTokens: 1, outputTokens: 2 };
    expect(u.orchestrationTokens).toBeUndefined();
    expect(u.orchestrationInputTokens).toBeUndefined();
    expect(u.orchestrationInputCachedTokens).toBeUndefined();
    expect(u.orchestrationOutputTokens).toBeUndefined();
  });
});

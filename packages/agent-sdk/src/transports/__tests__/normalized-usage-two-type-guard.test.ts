import { describe, it, expect } from 'vitest';
import type { NormalizedUsage as EngineUsage } from '../../engine/transport.js';
import type { NormalizedUsage as ContractUsage } from '../../contract/events.js';

// The two NormalizedUsage shapes are distinct and BOTH must carry
// orchestrationTokens, or the field is written but invisible at the cost
// boundary (the documented trap, spec §4.2). These assignments fail to
// compile if either type is missing the field.
describe('NormalizedUsage two-type orchestration-token guard', () => {
  it('engine NormalizedUsage carries orchestrationTokens', () => {
    const u: EngineUsage = { inputTokens: 1, outputTokens: 2, orchestrationTokens: 7 };
    expect(u.orchestrationTokens).toBe(7);
  });

  it('contract NormalizedUsage carries orchestrationTokens', () => {
    const u: ContractUsage = { inputTokens: 1, outputTokens: 2, orchestrationTokens: 9 };
    expect(u.orchestrationTokens).toBe(9);
  });

  it('the field is optional on both (omission stays valid — byte-identical for existing writers)', () => {
    const e: EngineUsage = { inputTokens: 0, outputTokens: 0 };
    const c: ContractUsage = { inputTokens: 0, outputTokens: 0 };
    expect(e.orchestrationTokens ?? null).toBeNull();
    expect(c.orchestrationTokens ?? null).toBeNull();
  });

  // The same trap for Anthropic's 5m/1h cache-write split: the transport writes the
  // engine type, the sink reads the contract type — drop either and the split is
  // written but never reaches the AGENT_USAGE wire (and every 1h write bills at 5m).
  it('both carry the Anthropic 5m/1h cache-write split', () => {
    const e: EngineUsage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 5, cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 5 };
    const c: ContractUsage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 5, cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 5 };
    expect(e.cacheCreation1hInputTokens).toBe(5);
    expect(c.cacheCreation1hInputTokens).toBe(5);
  });
});

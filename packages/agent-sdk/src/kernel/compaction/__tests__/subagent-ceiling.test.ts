/**
 * COMPACTION_V2 — the subagent lane's context ceiling.
 *
 * The verdict this encodes: PR #2600's `wireMessages` seam does NOT cover
 * subagents. A child has no journal projection — it accumulates one in-memory
 * ProviderHistory array across up to 30 rounds — so there is nothing to elide and
 * nothing to measure, and `compaction` is not even in the round core's config
 * `Pick`. The child gets a bounded output contract instead of a cut.
 */
import { describe, it, expect } from 'vitest';
import { subagentCeilingReached, SUBAGENT_CONTEXT_CEILING_NUDGE } from '../subagent-ceiling.js';
import { resolveTriggerPoint, DEFAULT_TRIGGER_POLICY } from '../trigger.js';

/** A history whose serialized form is ~`tokens` by the ledger's chars/4 heuristic. */
function historyOfTokens(tokens: number): unknown {
  return [{ role: 'user', content: 'x'.repeat(tokens * 4) }];
}

describe('subagentCeilingReached', () => {
  it('does NOT trip on a small child history', () => {
    expect(subagentCeilingReached(historyOfTokens(1_000), 'claude-sonnet-5')).toBe(false);
  });

  it('trips once the child crosses the SAME bound the parent trigger uses', () => {
    const bound = resolveTriggerPoint('claude-sonnet-5', DEFAULT_TRIGGER_POLICY).triggerTokens;
    expect(bound).toBe(180_000); // the 200k preferred ceiling (x0.9), not the 800k window ceiling
    expect(subagentCeilingReached(historyOfTokens(bound + 5_000), 'claude-sonnet-5')).toBe(true);
  });

  it('a child on a model with no preferred ceiling uses that model\'s window ceiling instead', () => {
    // haiku: 200k window, no preferred ceiling → 160k.
    expect(subagentCeilingReached(historyOfTokens(120_000), 'claude-haiku-4-5')).toBe(false);
    expect(subagentCeilingReached(historyOfTokens(170_000), 'claude-haiku-4-5')).toBe(true);
  });

  it('a circular history measures 0 and never cuts the child short', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(subagentCeilingReached(circular, 'claude-sonnet-5')).toBe(false);
  });

  it('the nudge tells the model to ANSWER and to admit what it missed', () => {
    expect(SUBAGENT_CONTEXT_CEILING_NUDGE).toMatch(/final answer/i);
    expect(SUBAGENT_CONTEXT_CEILING_NUDGE).toMatch(/did not get to/i);
  });
});

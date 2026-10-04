/**
 * compaction-budget.ts — the ONE number compaction and elision both size against.
 *
 * The bug this module exists to close: `maybeCompact` resolved the two-bound
 * trigger while `prepareElision` passed the raw context window into a policy
 * whose fractions were derived on a 200k model. On every model that declares a
 * preferred input ceiling the trigger is pinned at 180,000 (or 244,800) whatever
 * the window is, while the elision fractions scale WITH the window — so on a 1M
 * lane compaction rewrote history at 180,000 while elision's first cut wanted
 * 550,000, and the mechanism could never fire.
 *
 * The last case is that finding, as an assertion: the SAME journal is inert
 * against the window and live against the budget.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveCompactionBudget } from '../compaction-budget.js';
import { computeElisionCut } from '../../kernel/compaction/elide.js';
import { resolveMaxContextTokens } from '../../kernel/journal/token-ledger.js';
import type { JournalEntry } from '../../contract/journal.js';

const V2 = 'COMPACTION_V2';

afterEach(() => {
  delete process.env[V2];
});

/** ~15,000 estimated tokens of tool output per round. */
const fatBody = 'result-line-of-output '.repeat(2_700);

let seq = 0;
function entry(payload: JournalEntry['payload']): JournalEntry {
  seq++;
  return {
    uuid: `e-${seq}`,
    parentUuid: seq === 1 ? null : `e-${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  } as JournalEntry;
}

/** `turns` rounds of user → tool_use → fat tool_result → assistant. */
function conversation(turns: number): JournalEntry[] {
  seq = 0;
  const out: JournalEntry[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(entry({ type: 'user', blocks: [{ type: 'text', text: `q${i}` }] } as never));
    out.push(
      entry({ type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { p: i } } as never),
    );
    out.push(
      entry({
        type: 'tool_result',
        toolUseId: `tu-${i}`,
        blocks: [{ type: 'text', text: fatBody }],
      } as never),
    );
    out.push(entry({ type: 'assistant', blocks: [{ type: 'text', text: `a${i}` }] } as never));
  }
  return out;
}

// ─── The resolver ─────────────────────────────────────────────────────────────

describe('resolveCompactionBudget — COMPACTION_V2 ON: the two-bound trigger', () => {
  it('a declared preferred ceiling pins the budget regardless of window size', () => {
    process.env[V2] = 'true';
    // 1M window, preferredMaxInputTokens 200,000 → 0.9 x 200,000.
    expect(resolveCompactionBudget('claude-sonnet-5', {})).toBe(180_000);
    // 500k window, same preferred ceiling → the SAME budget. This is the point:
    // the budget does not scale with the window, so neither may the policy.
    expect(resolveCompactionBudget('grok-4.5', {})).toBe(180_000);
    // 1,050k window, 272,000 preferred.
    expect(resolveCompactionBudget('gpt-5.6-luna', {})).toBe(244_800);
  });

  it('a model with NO declared preferred ceiling falls back to the window ceiling', () => {
    process.env[V2] = 'true';
    // These four declare no preferredMaxInputTokens, so 0.8 x window is the bound.
    expect(resolveCompactionBudget('deepseek-v4-flash', {})).toBeCloseTo(838_860.8, 1);
    expect(resolveCompactionBudget('glm-5.2', {})).toBe(800_000);
    expect(resolveCompactionBudget('gpt-5.4', {})).toBe(800_000);
    expect(resolveCompactionBudget('claude-haiku-4-5', {})).toBe(160_000);
  });
});

describe('resolveCompactionBudget — COMPACTION_V2 OFF: the window ceiling only', () => {
  it('ignores the preferred ceiling, exactly as the pre-V2 predicate did', () => {
    expect(resolveCompactionBudget('claude-sonnet-5', {})).toBe(800_000);
    expect(resolveCompactionBudget('grok-4.5', {})).toBe(400_000);
  });

  it('is EQUIVALENT to the predicate it replaced, across the boundary', () => {
    // maybeCompact used to read `ledgerTotal / maxTokens < thresholdPct`; it now
    // reads `ledgerTotal < resolveCompactionBudget(...)`. Same decision, or the
    // flag-off path is not byte-identical.
    let agreed = 0;
    let firedAtLeastOnce = 0;
    for (const model of ['claude-sonnet-5', 'grok-4.5', 'deepseek-v4-flash', 'claude-haiku-4-5']) {
      const maxTokens = resolveMaxContextTokens(model);
      for (const thresholdPct of [0.5, 0.8, 0.99]) {
        const budget = resolveCompactionBudget(model, { thresholdPct });
        for (const delta of [-2, -1, 0, 1, 2]) {
          const ledgerTotal = Math.round(maxTokens * thresholdPct) + delta;
          const oldSaysCompact = !(ledgerTotal / maxTokens < thresholdPct);
          const newSaysCompact = !(ledgerTotal < budget);
          expect(newSaysCompact).toBe(oldSaysCompact);
          agreed++;
          if (newSaysCompact) firedAtLeastOnce++;
        }
      }
    }
    // Positive control: the sweep straddled the boundary in both directions, so
    // the agreement above is not "both always false".
    expect(agreed).toBe(60);
    expect(firedAtLeastOnce).toBeGreaterThan(0);
    expect(firedAtLeastOnce).toBeLessThan(agreed);
  });
});

describe('resolveCompactionBudget — the degenerate cases', () => {
  it('no compaction config ⇒ nothing rewrites history ⇒ the wall is the window', () => {
    process.env[V2] = 'true';
    expect(resolveCompactionBudget('claude-sonnet-5', undefined)).toBe(1_000_000);
    expect(resolveCompactionBudget('claude-haiku-4-5', undefined)).toBe(200_000);
  });

  it('a configured thresholdPct moves the budget', () => {
    expect(resolveCompactionBudget('claude-sonnet-5', { thresholdPct: 0.5 })).toBe(500_000);
    process.env[V2] = 'true';
    // …but never ABOVE the preferred bound, which is the whole point of the min.
    expect(resolveCompactionBudget('claude-sonnet-5', { thresholdPct: 0.99 })).toBe(180_000);
  });

  it('an unknown model resolves through the registry fallback, not NaN', () => {
    process.env[V2] = 'true';
    expect(resolveCompactionBudget('fake-model', {})).toBe(160_000);
  });
});

// ─── THE FINDING, as an assertion ─────────────────────────────────────────────

describe('the re-base is what makes elision reachable at all', () => {
  it('the SAME journal is inert against the window and live against the budget', () => {
    process.env[V2] = 'true';
    const model = 'claude-sonnet-5';
    // 8 rounds x ~15,000 tokens = ~120,000 of journal text. Real depth for a long
    // task, and comfortably under this model's 180,000 compaction trigger.
    const entries = conversation(8);

    // OLD base — resolveMaxContextTokens: liveWindow alone is 250,000, so a
    // 120,000-token conversation is not even in the running.
    const againstWindow = computeElisionCut(entries, resolveMaxContextTokens(model));
    expect(againstWindow.resultCutTokens).toBe(0);
    expect(againstWindow.strideTokens).toBe(300_000);

    // NEW base — the compaction trigger.
    const againstBudget = computeElisionCut(entries, resolveCompactionBudget(model, {}));
    expect(againstBudget.strideTokens).toBe(54_000);
    expect(againstBudget.resultCutTokens).toBe(54_000);
  });

  it('and the budget is BELOW the depth the old policy needed, on every preferred-ceiling lane', () => {
    process.env[V2] = 'true';
    for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'grok-4.5', 'gpt-5.6-luna']) {
      const oldFirstCut = 0.55 * resolveMaxContextTokens(model);
      const budget = resolveCompactionBudget(model, {});
      // Compaction rewrites history strictly before elision's old first cut —
      // that is the structural reason the mechanism measured 0 in 60 days.
      expect(budget).toBeLessThan(oldFirstCut);
    }
  });
});

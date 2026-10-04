/**
 * The task-budget gate's SCOPE — new spend, never lifetime (incident 14a935ea,
 * prod 2026-08-27).
 *
 * The incident: `maxBudgetUsd` is minted per message from the LIVE balance
 * ("what the account can afford from here"), while the run's cumulative is
 * task-LIFETIME (the resume seed restores history so re-billing is impossible).
 * The gate compared the two — every already-paid dollar counted once when it
 * left the wallet and again as a claim against what was left — so a funded user
 * (1,840 credits ⇒ $14.72 affordable) with a $15.37-lifetime task got instant
 * $0.00 `max_budget` trips and a card telling them to recharge.
 *
 * What these pin:
 *  - a task whose HISTORY exceeds the freshly-minted budget still OPENS and
 *    runs, with the seeded history intact in the books (the Ankur regression,
 *    his exact numbers);
 *  - a budget of 0 (empty wallet, or a fully-consumed per-task limit netted to
 *    0 server-side) still refuses at the head, recoverably;
 *  - the outcome names the BINDING constraint (`cfg.maxBudgetSource` →
 *    `triggeredBy`) so the card can say "Task budget reached · Adjust limit"
 *    instead of wearing the wallet's recharge copy for every stop;
 *  - the gate is a TURN-HEAD gate: a turn's own spend does not retro-trip the
 *    head that already passed (mid-turn runaways are the ceiling's job).
 */
import { describe, it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import { createLiveSpendLedger, type LiveSpendLedger } from '../live-spend.js';

function doneEvent(costUsd: number, stopReason: string): StreamEvent {
  return {
    kind: 'done',
    stopReason,
    usage: { inputTokens: 1, outputTokens: 1, costUsd } as NormalizedUsage,
  };
}

/** One priced text-only round (terminates the turn). */
function textRound(costUsd: number): StreamEvent[] {
  return [{ kind: 'text', text: 'ok' } as StreamEvent, doneEvent(costUsd, 'end_turn')];
}

/** Serves scripted rounds in order (clamping on the last); prices off `usage.costUsd`. */
class ScriptTransport extends FakeTransport {
  calls = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const round = this.rounds[Math.min(this.calls, this.rounds.length - 1)];
    this.calls += 1;
    return round;
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

const noopToolHost: ToolHost = {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    return { tools: [], onAuthHalt: async () => {} };
  },
};

type TurnEnd = Extract<HarnessEvent, { kind: 'turn_end' }>;

async function runTurns(opts: {
  rounds: StreamEvent[][];
  turns?: number;
  maxBudgetUsd?: number;
  maxBudgetSource?: 'credits' | 'task_limit';
  getBudgetMint?: () => { usd?: number; source?: 'credits' | 'task_limit' };
  initialCostUsd?: number;
  liveSpend?: LiveSpendLedger;
}): Promise<{ ends: TurnEnd[]; transport: ScriptTransport }> {
  const transport = new ScriptTransport(opts.rounds);
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost: noopToolHost,
    ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    ...(opts.maxBudgetSource !== undefined ? { maxBudgetSource: opts.maxBudgetSource } : {}),
    ...(opts.getBudgetMint !== undefined ? { getBudgetMint: opts.getBudgetMint } : {}),
    ...(opts.initialCostUsd !== undefined ? { initialCostUsd: opts.initialCostUsd } : {}),
    ...(opts.liveSpend !== undefined ? { liveSpend: opts.liveSpend } : {}),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 'task-budget-scope',
    sessionId: 's-budget-scope',
    cwd: '/tmp',
    model: 'fake-model',
    signal: new AbortController().signal,
    config: cfg,
  };
  const n = opts.turns ?? 1;
  const input = (async function* (): AsyncIterable<UserTurn> {
    for (let i = 0; i < n; i++) yield { text: `go ${i}` };
  })();
  const ends: TurnEnd[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) {
    if (ev.kind === 'turn_end') ends.push(ev as TurnEnd);
  }
  return { ends, transport };
}

describe('the budget gate compares NEW spend, never lifetime', () => {
  it('ANKUR REGRESSION: history $15.37 vs budget $14.72 — the turn OPENS and runs', async () => {
    // Before the fix this was an instant max_budget at the head (15.37 >= 14.72)
    // with zero model calls — the funded user's "Out of credits" card.
    const { ends, transport } = await runTurns({
      rounds: [textRound(0.05)],
      maxBudgetUsd: 14.72,
      initialCostUsd: 15.37,
      liveSpend: createLiveSpendLedger(),
    });
    expect(transport.calls).toBe(1); // a real model call happened
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome.kind).not.toBe('max_budget');
    // The seeded history stays in the books — scope-fixing the gate must not
    // erase the lifetime figure the billing rides on.
    expect(ends[0]!.billing!.cumulativeCostUsd).toBeCloseTo(15.42, 5);
  });

  it('a budget of 0 still refuses at the head — empty wallet or consumed task limit', async () => {
    const { ends, transport } = await runTurns({
      rounds: [textRound(0.05)],
      maxBudgetUsd: 0,
      liveSpend: createLiveSpendLedger(),
    });
    expect(transport.calls).toBe(0); // refused BEFORE any model call
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome.kind).toBe('max_budget');
    // Absent maxBudgetSource → the wallet copy (forward-compatible default).
    expect(ends[0]!.outcome.kind === 'max_budget' && ends[0].outcome.triggeredBy).toBe('credits');
  });

  it("the outcome names the BINDING constraint: source 'task_limit' → triggeredBy 'task_limit'", async () => {
    const { ends } = await runTurns({
      rounds: [textRound(0.05)],
      maxBudgetUsd: 0,
      maxBudgetSource: 'task_limit',
      liveSpend: createLiveSpendLedger(),
    });
    expect(ends[0]!.outcome.kind).toBe('max_budget');
    expect(ends[0]!.outcome.kind === 'max_budget' && ends[0].outcome.triggeredBy).toBe('task_limit');
  });

  it('head-only by design: a turn whose own spend crosses the budget still completes; the ceiling owns mid-turn', async () => {
    const { ends, transport } = await runTurns({
      rounds: [textRound(0.5)],
      maxBudgetUsd: 0.1, // the round costs 5× the budget
      liveSpend: createLiveSpendLedger(),
    });
    expect(transport.calls).toBe(1);
    expect(ends[0]!.outcome.kind).not.toBe('max_budget');
  });

  it('no-ledger fallback derives the same turn scope from the billing baselines', async () => {
    // liveSpend absent → the gate falls back to (cumulative − turnStart − seed),
    // which is 0 at the head even on a seeded resume: still opens.
    const { ends, transport } = await runTurns({
      rounds: [textRound(0.05)],
      maxBudgetUsd: 14.72,
      initialCostUsd: 15.37,
    });
    expect(transport.calls).toBe(1);
    expect(ends[0]!.outcome.kind).not.toBe('max_budget');
  });
});


describe('the LIVE mint wins over the construction snapshot (warm adoption)', () => {
  it('a warm run whose fresh frame minted 0/task_limit trips honestly despite a stale positive cfg', async () => {
    // The freeze rail keeps runs warm across hibernation, so cfg.maxBudgetUsd
    // never refreshes — drill 3c6f2a73: a turn ran $0.0122 past a spent $0.01
    // limit. The getter is the freshest frame's mint; it must gate the head.
    const { ends, transport } = await runTurns({
      rounds: [textRound(0.05)],
      maxBudgetUsd: 5, // stale construction snapshot says plenty
      getBudgetMint: () => ({ usd: 0, source: 'task_limit' }),
      liveSpend: createLiveSpendLedger(),
    });
    expect(transport.calls).toBe(0);
    expect(ends[0]!.outcome.kind).toBe('max_budget');
    expect(ends[0]!.outcome.kind === 'max_budget' && ends[0]!.outcome.triggeredBy).toBe('task_limit');
  });

  it('an EMPTY live mint falls back to the statics — cold resumes and legacy wiring unchanged', async () => {
    const { ends, transport } = await runTurns({
      rounds: [textRound(0.05)],
      maxBudgetUsd: 0,
      maxBudgetSource: 'credits',
      getBudgetMint: () => ({}),
      liveSpend: createLiveSpendLedger(),
    });
    expect(transport.calls).toBe(0);
    expect(ends[0]!.outcome.kind).toBe('max_budget');
    expect(ends[0]!.outcome.kind === 'max_budget' && ends[0]!.outcome.triggeredBy).toBe('credits');
  });

  it('a fresh generous mint UNLOCKS a run whose stale snapshot was 0 (the clear-the-limit flow, warm)', async () => {
    const { ends, transport } = await runTurns({
      rounds: [textRound(0.05)],
      maxBudgetUsd: 0, // stale: exhausted at construction
      getBudgetMint: () => ({ usd: 20, source: 'credits' }),
      liveSpend: createLiveSpendLedger(),
    });
    expect(transport.calls).toBe(1);
    expect(ends[0]!.outcome.kind).not.toBe('max_budget');
  });
});

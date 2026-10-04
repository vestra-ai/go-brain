/**
 * Agent v2 — Task 6 (finding 4): a HITL subagent re_execute REPLAY's attributed
 * child cost must survive the resume boundary.
 *
 * On resume, the paused subagent is RE-SPAWNED during `materialize` (BEFORE the
 * drive turn). Its replay cost is folded into the drive turn's cumulative via
 * `config.initialCostUsd` so the single authoritative AGENT_RESULT bills it once.
 * BUT the run() per-turn boundary RESETs `childUsage = []` and snapshots
 * `turnStartCumulative = cumulativeCostUsd` — which already includes the replay
 * cost. Left alone, the replay child VANISHES from `childUsage` and the replay
 * cost is EXCLUDED from `turnDeltaUsd`, breaking the per-turn invariant by exactly
 * `initialCostUsd`.
 *
 * The fix: `config.initialChildUsage` SEEDS the first drive turn's `childUsage`
 * with the replay's records, and the turn-start cumulative baseline SUBTRACTS the
 * seeded sum so the replay cost lands in THIS turn's delta. The invariant
 * `parentOwn + Σchild === turnDelta` then holds across the resume.
 */
import { describe, it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { ChildCostRecord } from '../../contract/child-cost.js';

function doneEvent(costUsd: number): StreamEvent {
  return {
    kind: 'done',
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, costUsd } as NormalizedUsage,
  };
}

/** Serves the drive turn's ONE billed parent round (driveParentOwnUsd) + a terminator. */
class DriveTransport extends FakeTransport {
  private idx = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

interface TurnBilling {
  cumulativeCostUsd: number;
  turnDeltaUsd: number;
  parentOwnCostUsd: number;
  childUsage: ChildCostRecord[];
}

/**
 * Model the query-manager re-exec fold-forward: the replay re-spawned a subagent
 * whose OWN cost (replayChildUsd) was folded via addCostUsd (→ initialCostUsd) AND
 * attributed via addChildCost (→ initialChildUsage). Then ONE drive turn runs the
 * parent's own model round (driveParentOwnUsd). Returns the drive turn's billing.
 */
async function resumeReExec(args: {
  replayChildUsd: number;
  driveParentOwnUsd: number;
  seedChildUsage: boolean;
}): Promise<TurnBilling> {
  const replayRec: ChildCostRecord = {
    childId: 'replay',
    model: 'child-model',
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: args.replayChildUsd,
  };
  const transport = new DriveTransport([
    [doneEvent(args.driveParentOwnUsd)], // the parent's own billed round
    [{ kind: 'text', text: 'ok' }, doneEvent(0)], // terminator (completes the turn)
  ]);
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    // Fold-forward seeds (parallel to query-manager.ts re-exec path):
    initialCostUsd: args.replayChildUsd,
    ...(args.seedChildUsage ? { initialChildUsage: [replayRec] } : {}),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 't1',
    sessionId: 's1',
    cwd: '/tmp',
    model: 'fake-model',
    signal: new AbortController().signal,
    config: cfg,
  };
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go', continueInteraction: true };
  })();

  let last: TurnBilling | undefined;
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'turn_end' && ev.billing) {
      const b = ev.billing as Partial<TurnBilling> & { cumulativeCostUsd: number };
      last = {
        cumulativeCostUsd: b.cumulativeCostUsd,
        turnDeltaUsd: b.turnDeltaUsd as number,
        parentOwnCostUsd: b.parentOwnCostUsd as number,
        childUsage: (b.childUsage ?? []) as ChildCostRecord[],
      };
    }
  }
  if (!last) throw new Error('no terminal turn_end');
  return last;
}

describe('native-harness re-exec replay seed (Agent v2 Task 6, finding 4)', () => {
  it('re-exec replay collects child records AND keeps the invariant (no loss by initialCostUsd)', async () => {
    const out = await resumeReExec({ replayChildUsd: 0.07, driveParentOwnUsd: 0.02, seedChildUsage: true });
    const childSum = out.childUsage.reduce((a, r) => a + r.costUsd, 0);
    expect(childSum).toBeCloseTo(0.07, 9); // replay child attributed, not dropped
    expect(out.parentOwnCostUsd).toBeCloseTo(0.02, 9); // the drive turn's own cost
    expect(out.turnDeltaUsd).toBeCloseTo(0.09, 9); // replay (0.07) IS in this turn's delta
    expect(out.parentOwnCostUsd + childSum).toBeCloseTo(out.turnDeltaUsd, 9); // invariant survives resume
    expect(out.cumulativeCostUsd).toBeCloseTo(0.09, 9); // cumulative bills both, once
  });

  it('WITHOUT the seed the replay child vanishes (locks the seed as the fix, byte-identical otherwise)', async () => {
    const out = await resumeReExec({ replayChildUsd: 0.07, driveParentOwnUsd: 0.02, seedChildUsage: false });
    expect(out.childUsage).toHaveLength(0); // dropped — the bug finding 4 fixes
    expect(out.turnDeltaUsd).toBeCloseTo(0.02, 9); // replay excluded from the delta
    expect(out.cumulativeCostUsd).toBeCloseTo(0.09, 9); // initialCostUsd still folds into cumulative
  });
});

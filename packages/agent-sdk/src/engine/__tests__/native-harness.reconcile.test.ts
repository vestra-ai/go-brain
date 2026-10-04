/**
 * Agent v2 — Task 4: per-turn billing reconciliation (the billing-correctness KEYSTONE).
 *
 * The native loop accumulates `cumulativeCostUsd` MONOTONICALLY across every warm
 * turn of one `query()` run; the server charges only the per-turn DELTA. This suite
 * proves the kernel surfaces, on each turn_end, three INDEPENDENTLY-measured
 * quantities that reconcile:
 *
 *   parentOwnCostUsd + Σ(child own cost) === turnDeltaUsd
 *
 * where:
 *   - `parentOwnCostUsd` is advanced ONLY at the PARENT's own model rounds (+ compaction)
 *     — NEVER derived as `cumulative − Σchild` (a derived value makes the invariant
 *     `Σchild + (delta − Σchild) === delta`, a tautology that cannot detect a mis-count).
 *   - `childUsage` is reset at each user-turn boundary (per-turn, not run-cumulative).
 *   - `turnDeltaUsd` is `cumulativeCostUsd_end − cumulativeCostUsd_turnStart`.
 *
 * The NEGATIVE CONTROL (a deliberately double-folded child) proves the invariant has
 * TEETH: with an independent `parentOwnCostUsd` the double-count is DETECTED; were it
 * derived, the same bug would be masked (the tautology would still hold).
 *
 * The loop is driven through the REAL `run()` async generator over a scripted
 * `FakeTransport`; a child subagent is simulated by a tool that folds its own cost
 * via `ctx.addCostUsd` (the budget roll-up) AND emits an attributed `ctx.addChildCost`
 * record — exactly what the Agent tool does (Tasks 1–3).
 */
import { describe, it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { ChildCostRecord } from '../../contract/child-cost.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

// The parent's own model cost for a turn whose `parentRoundsUsd` is unspecified.
const DEFAULT_PARENT_USD = 0.03;

interface TurnSpec {
  /** Per-child OWN cost; each child folds this via addCostUsd AND addChildCost. */
  children: number[];
  /** The parent's own model-round cost(s) for the turn (summed). Default [0.03]. */
  parentRoundsUsd?: number[];
  /** NEGATIVE CONTROL: each child emits its addChildCost record TWICE. */
  buggyDoubleFold?: boolean;
}

/** Per-turn billing surface read off each terminal turn_end. */
interface TurnBilling {
  cumulativeCostUsd: number;
  turnDeltaUsd: number;
  parentOwnCostUsd: number;
  childUsage: ChildCostRecord[];
}

function doneEvent(costUsd: number): StreamEvent {
  // The round cost rides on `usage.costUsd`; the scripted transport's computeCostUsd
  // reads it back (decoupled from round indexing → robust against retries).
  return {
    kind: 'done',
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, costUsd } as NormalizedUsage,
  };
}

/**
 * Build the per-round stream scripts for a whole (possibly multi-turn) warm run.
 * Each turn = ONE billed parent round that emits the children's tool_use calls,
 * then a zero-cost terminator round (plain text) that completes the turn.
 */
function buildRounds(specs: TurnSpec[]): StreamEvent[][] {
  const rounds: StreamEvent[][] = [];
  specs.forEach((spec, t) => {
    const parentCost = (spec.parentRoundsUsd ?? [DEFAULT_PARENT_USD]).reduce((a, b) => a + b, 0);
    const childCalls: StreamEvent[] = spec.children.map((c, i) => ({
      kind: 'tool_use',
      toolUse: { id: `t${t}-c${i}`, name: 'spawn_child', input: { costUsd: c, childId: `t${t}-c${i}` } },
    }));
    rounds.push([...childCalls, doneEvent(parentCost)]); // billed parent round + child calls
    rounds.push([{ kind: 'text', text: 'ok' }, doneEvent(0)]); // terminator (completes the turn)
  });
  return rounds;
}

/** A transport that serves scripted rounds in order and prices each off `usage.costUsd`. */
class ScriptTransport extends FakeTransport {
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

/** A ToolHost exposing a single `spawn_child` tool that simulates a leaf subagent. */
class ChildToolHost implements ToolHost {
  constructor(private readonly buggyDoubleFold: boolean) {}
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const buggy = this.buggyDoubleFold;
    const tool: RawToolOptions = {
      name: 'spawn_child',
      description: 'simulated leaf subagent that folds its own cost into the parent turn',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: (args, context) => {
        const { costUsd, childId } = args as { costUsd: number; childId: string };
        // Fold the child's INCLUSIVE cost into the parent budget (leaf: own === inclusive).
        context.addCostUsd?.(costUsd);
        const rec: ChildCostRecord = {
          childId,
          model: 'child-model',
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd,
        };
        context.addChildCost?.(rec);
        // NEGATIVE CONTROL: attribute the SAME child twice (a double-fold). The budget
        // (addCostUsd) is folded once; only the attributed list is corrupted — exactly
        // the mis-count an independent parentOwn accumulator must be able to DETECT.
        if (buggy) context.addChildCost?.({ ...rec });
        return `child ${childId} complete`;
      },
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  }
}

function buildCtx(transport: FakeTransport, toolHost: ToolHost): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost,
  } as unknown as NativeConfig;
  return { taskId: 't1', sessionId: 's1', cwd: '/tmp', model: 'fake-model', signal: new AbortController().signal, config: cfg };
}

/** Drive the whole warm run; return each turn's billing surface IN ORDER. */
async function driveRun(specs: TurnSpec[]): Promise<TurnBilling[]> {
  const transport = new ScriptTransport(buildRounds(specs));
  const toolHost = new ChildToolHost(specs.some((s) => s.buggyDoubleFold));
  const ctx = buildCtx(transport, toolHost);
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    for (let i = 0; i < specs.length; i++) yield { text: 'go' };
  })();

  const turns: TurnBilling[] = [];
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'turn_end' && ev.billing) {
      const b = ev.billing as Partial<TurnBilling> & { cumulativeCostUsd: number };
      turns.push({
        cumulativeCostUsd: b.cumulativeCostUsd,
        turnDeltaUsd: b.turnDeltaUsd as number,
        parentOwnCostUsd: b.parentOwnCostUsd as number,
        childUsage: (b.childUsage ?? []) as ChildCostRecord[],
      });
    }
  }
  return turns;
}

/** Single-turn convenience wrapper. */
async function runTurnWith(spec: TurnSpec): Promise<TurnBilling> {
  const [turn] = await driveRun([spec]);
  return turn;
}

describe('native-harness per-turn reconciliation (Agent v2 Task 4)', () => {
  it('reconciles per-turn: independently-measured parentOwn + Σ(child own) === turn delta', async () => {
    // 1 parent round (0.03) then 2 children (0.10, 0.05) in ONE user turn.
    const out = await runTurnWith({ parentRoundsUsd: [0.03], children: [0.10, 0.05] });
    expect(out.parentOwnCostUsd).toBeCloseTo(0.03, 9); // measured at the model round, NOT derived
    const childSum = out.childUsage.reduce((a, r) => a + r.costUsd, 0);
    expect(childSum).toBeCloseTo(0.15, 9);
    expect(out.turnDeltaUsd).toBeCloseTo(0.18, 9);
    expect(out.parentOwnCostUsd + childSum).toBeCloseTo(out.turnDeltaUsd, 9); // independent agreement
  });

  it('childUsage is PER-TURN: turn 2 does not re-list turn 1 children', async () => {
    const [t1, t2] = await driveRun([{ children: [0.10] }, { children: [0.05] }]); // same warm query()
    expect(t1.childUsage.map((r) => r.costUsd)).toEqual([0.10]);
    expect(t2.childUsage.map((r) => r.costUsd)).toEqual([0.05]); // NOT [0.10, 0.05]
    expect(t2.turnDeltaUsd).toBeCloseTo(0.05 + t2.parentOwnCostUsd, 9);
  });

  it('a deliberately mis-counted (double-folded) child FAILS the invariant', async () => {
    const out = await runTurnWith({ parentRoundsUsd: [0.03], children: [0.10], buggyDoubleFold: true });
    const childSum = out.childUsage.reduce((a, r) => a + r.costUsd, 0);
    expect(out.parentOwnCostUsd + childSum).not.toBeCloseTo(out.turnDeltaUsd, 9); // proves it has teeth
  });
});

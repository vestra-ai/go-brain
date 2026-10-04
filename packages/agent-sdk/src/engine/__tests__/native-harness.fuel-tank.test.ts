/**
 * Weave Floor §1a — the SESSION FUEL TANK wired into the concurrent `:turnbatch`
 * Agent batch (native-harness.ts). This is the Agent-v2 bill-shock prod gate (design
 * §6.4 R1): a 12-wide all-`Agent` round had NO fuel cap and could overshoot by ~12
 * nodes' spend; the tank now reserves each node's true ceiling at admission and STOPS
 * SCHEDULING once the session ceiling would be breached, returning partial results.
 *
 * Two axes (the gated-feature test discipline):
 *  - flag-ON: with `sessionFuelTankUsd` set, a wide batch admits only as many nodes as
 *    fit under the ceiling; the rest are DENIED before launch (no run, no model bill, no
 *    per-tool action bill) and surface a skip note.
 *  - flag-OFF (control): with `sessionFuelTankUsd` undefined, ALL nodes run — byte-
 *    identical to pre-1a — proving the test exercises the tank, not some other limit.
 */
import { describe, it, expect, vi } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { defaultNodeReserveUsd, _resetFuelTanksForTest } from '../fuel-tank.js';
import { resolveCapabilities } from '../../contract/model-capabilities.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ChildCostRecord } from '../../contract/child-cost.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

const MODEL = 'claude-sonnet-4-6';
// The per-node reserve the harness computes for this model (input bound 32k + the
// model's enforced maxOutputTokens, at the model's rate), derived via the SAME
// functions the harness uses → robust to capability/price changes. We make each child's
// ACTUAL cost EQUAL its reserve, so the headroom a node consumes is identical whether it
// is in-flight (held as an outstanding reserve) or already completed (folded into live
// spend). That makes the admitted COUNT timing-independent — floor((ceiling−parent)/
// reserve) — instead of drifting with microtask scheduling of cheap, fast-completing nodes.
const RESERVE = defaultNodeReserveUsd(MODEL, resolveCapabilities(MODEL).maxOutputTokens);
const CHILD_USD = RESERVE;

function doneEvent(costUsd: number): StreamEvent {
  return {
    kind: 'done',
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, costUsd } as NormalizedUsage,
  };
}

/** A transport that serves scripted rounds in order; prices off `usage.costUsd`. */
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

/**
 * One parent round emitting `n` CONCURRENT `Agent` tool_uses (REEXECUTE_BOUND → the
 * concurrent :turnbatch path), then a zero-cost terminator round.
 */
function buildRounds(parentCostUsd: number, n: number, childCosts?: number[]): StreamEvent[][] {
  const calls: StreamEvent[] = Array.from({ length: n }, (_, i) => ({
    kind: 'tool_use',
    toolUse: {
      id: `tu-${i}`,
      name: 'Agent',
      input: { childId: `child-${i}`, costUsd: childCosts ? childCosts[i] : CHILD_USD },
    },
  }));
  return [
    [...calls, doneEvent(parentCostUsd)],
    [{ kind: 'text', text: 'done' }, doneEvent(0)],
  ];
}

/** A ToolHost whose single `Agent` tool folds the child model cost it is handed. */
class AgentToolHost implements ToolHost {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool: RawToolOptions = {
      name: 'Agent',
      description: 'simulated subagent',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: (args, context) => {
        const { childId, costUsd } = args as { childId: string; costUsd: number };
        context.addCostUsd?.(costUsd);
        const rec: ChildCostRecord = {
          childId,
          model: 'child-model',
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd,
        };
        context.addChildCost?.(rec);
        return `child ${childId} done`;
      },
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  }
}

function buildCtx(transport: FakeTransport, toolHost: ToolHost, sessionFuelTankUsd?: number): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost,
    ...(sessionFuelTankUsd !== undefined && { sessionFuelTankUsd }),
  } as unknown as NativeConfig;
  return { taskId: 'tank-t', sessionId: 'tank-s', cwd: '/tmp', model: MODEL, signal: new AbortController().signal, config: cfg };
}

async function runWideBatch(opts: {
  parentCostUsd: number;
  n: number;
  sessionFuelTankUsd?: number;
  childCosts?: number[];
}): Promise<Extract<HarnessEvent, { kind: 'turn_end' }>> {
  _resetFuelTanksForTest(); // distinct tank per case (root key 'tank-s' is reused)
  const transport = new ScriptTransport(buildRounds(opts.parentCostUsd, opts.n, opts.childCosts));
  const ctx = buildCtx(transport, new AgentToolHost(), opts.sessionFuelTankUsd);
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go' };
  })();
  let last: Extract<HarnessEvent, { kind: 'turn_end' }> | undefined;
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'turn_end') last = ev as Extract<HarnessEvent, { kind: 'turn_end' }>;
  }
  if (!last) throw new Error('no turn_end emitted');
  return last;
}

describe('Fuel tank — concurrent :turnbatch admission (bill-shock prod gate)', () => {
  const PARENT = 0.03;

  it('flag-OFF (no ceiling): a 5-wide Agent batch runs ALL children (byte-identical)', async () => {
    const ev = await runWideBatch({ parentCostUsd: PARENT, n: 5 });
    expect(ev.billing!.childUsage).toHaveLength(5);
    expect(ev.billing!.cumulativeCostUsd).toBeCloseTo(PARENT + 5 * RESERVE, 9);
  });

  it('flag-ON: a ceiling that fits exactly 2 reserves admits 2 children, DENIES the other 3', async () => {
    // ceiling admits exactly 2 nodes: 2·reserve ≤ (ceiling − parent) < 3·reserve. Because
    // each child's actual cost == its reserve, the count is timing-independent.
    const ceiling = PARENT + 2.5 * RESERVE;
    const ev = await runWideBatch({ parentCostUsd: PARENT, n: 5, sessionFuelTankUsd: ceiling });
    // Only the 2 ADMITTED children fold a childUsage record; the 3 denied never ran.
    expect(ev.billing!.childUsage).toHaveLength(2);
    // cumulative = parent + 2·reserve — the 3 denied nodes billed ZERO model cost.
    expect(ev.billing!.cumulativeCostUsd).toBeCloseTo(PARENT + 2 * RESERVE, 9);
  });

  it('flag-ON: a generous ceiling admits the whole batch (no false-trip on normal turns)', async () => {
    const ceiling = PARENT + 100 * RESERVE;
    const ev = await runWideBatch({ parentCostUsd: PARENT, n: 5, sessionFuelTankUsd: ceiling });
    expect(ev.billing!.childUsage).toHaveLength(5);
    expect(ev.billing!.cumulativeCostUsd).toBeCloseTo(PARENT + 5 * RESERVE, 9);
  });

  it('flag-ON: an exhausted ceiling (below one reserve) admits ZERO children', async () => {
    // ceiling below one node's reserve → the FIRST node already cannot reserve, and a
    // denial neither runs nor changes spend, so all 4 are denied deterministically.
    const ev = await runWideBatch({ parentCostUsd: PARENT, n: 4, sessionFuelTankUsd: PARENT + RESERVE * 0.5 });
    expect(ev.billing!.childUsage ?? []).toHaveLength(0);
    expect(ev.billing!.cumulativeCostUsd).toBeCloseTo(PARENT, 9);
  });
});

describe('Positive-spend tripwire (Weave Floor §1a item 5)', () => {
  it('WARNS when a completed turn that made a model call bills ZERO (zeroed-billing bug)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A genuine completion (the model produced end_turn) but parent round cost 0 and no
      // children → turnDelta 0. This is the native-multisubagent-cost-zeroed shape: a turn
      // that ran the model yet billed nothing. The tripwire must catch it.
      await runWideBatch({ parentCostUsd: 0, n: 0 });
      const fired = warn.mock.calls.some((c) => String(c[0]).includes('ZERO spend on a turn'));
      expect(fired).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays SILENT on a healthy turn (positive delta, reconcile holds)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // parent round cost 0.05, no children → turnDelta 0.05 > 0 and parentOwn+Σchild
      // reconciles → no tripwire warning at all.
      await runWideBatch({ parentCostUsd: 0.05, n: 0 });
      const fired = warn.mock.calls.some((c) => String(c[0]).includes('[billing-tripwire]'));
      expect(fired).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays SILENT on a healthy wide batch (parent + Σchild reconciles, delta > 0)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runWideBatch({ parentCostUsd: 0.03, n: 4, childCosts: [0.01, 0.02, 0.03, 0.04] });
      const fired = warn.mock.calls.some((c) => String(c[0]).includes('[billing-tripwire]'));
      expect(fired).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Synchronous-accumulator invariant (Weave Floor §1a item 4)', () => {
  // The concurrent :turnbatch closures fold each child's cost via `cumulativeCostUsd +=`
  // and `childUsage.push` (native-harness.ts) — single synchronous read-modify-writes
  // with NO await between read and write, so JS's single-threaded model guarantees no two
  // concurrent child completions interleave to lose an update (→ under-bill). This locks
  // that invariant: N concurrent children with DISTINCT costs must sum EXACTLY, and every
  // child's record must survive, with `parentOwn + Σchild === turnDelta` (cumulative).
  it('a concurrent batch of N distinct-cost children sums EXACTLY (no lost update)', async () => {
    const PARENT = 0.07;
    // 8 deliberately-distinct, non-round costs to surface any single dropped/merged fold.
    const childCosts = [0.011, 0.023, 0.037, 0.041, 0.059, 0.013, 0.029, 0.017];
    const ev = await runWideBatch({ parentCostUsd: PARENT, n: childCosts.length, childCosts });

    const expectedSum = childCosts.reduce((a, b) => a + b, 0);
    // Every child folded exactly one record (none lost to an interleaved write).
    expect(ev.billing!.childUsage).toHaveLength(childCosts.length);
    const recordedSum = ev.billing!.childUsage!.reduce((a, r) => a + r.costUsd, 0);
    expect(recordedSum).toBeCloseTo(expectedSum, 9);
    // parentOwn (PARENT) + Σchild === turnDelta (cumulative) — the billing keystone.
    expect(ev.billing!.cumulativeCostUsd).toBeCloseTo(PARENT + expectedSum, 9);
    // Each distinct cost is present exactly once (set equality, order-independent).
    expect(ev.billing!.childUsage!.map((r) => r.costUsd).sort()).toEqual([...childCosts].sort());
  });
});

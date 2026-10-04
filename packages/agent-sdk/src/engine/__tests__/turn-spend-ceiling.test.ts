/**
 * The PER-TURN spend ceiling (2026-08-24 burn).
 *
 * The burn: three unattended research turns ran for hours while every gate read
 * `rc.billing.cumulativeCostUsd` — a counter a child's spend only reaches when the
 * child COMPLETES — so the loop saw $0.19 while its children burned $125. Task 1
 * put the money on a live ledger; this is the gate that reads it.
 *
 * What these pin:
 *  - the trip is at a LOOP HEAD (before the next model call), in the parent loop
 *    and in BOTH subagent loop bodies, and the launch gate refuses new children;
 *  - the ceiling is PER TURN — a second user message starts a fresh baseline, so a
 *    long conversation is never permanently wedged by a turn that once tripped;
 *  - money already spent is still BOOKED (the trip's turn_end carries the real
 *    delta — a ceiling is not an excuse to lose a receipt);
 *  - with the knob absent every path runs exactly as it did before it existed.
 */
import { describe, it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type {
  Transport,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import type { HarnessContext, UserTurn, GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { OutputFormat } from '../../contract/output-format.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import { createLiveSpendLedger, turnSpendCeilingReached, type LiveSpendLedger } from '../live-spend.js';
import { runSubagentLoop } from '../subagent-runner.js';
import { fanOutChildren } from '../subagent-pool.js';

// ── the parent loop ──────────────────────────────────────────────────────────

function doneEvent(costUsd: number, stopReason: string): StreamEvent {
  return {
    kind: 'done',
    stopReason,
    usage: { inputTokens: 1, outputTokens: 1, costUsd } as NormalizedUsage,
  };
}

/** One priced round that calls `noop` (so the loop would iterate again). */
function toolRound(id: string, costUsd: number): StreamEvent[] {
  return [
    { kind: 'tool_use', toolUse: { id, name: 'noop', input: {} } } as StreamEvent,
    doneEvent(costUsd, 'tool_use'),
  ];
}

/** The terminator round — no tool calls, so the turn completes. */
function textRound(costUsd: number): StreamEvent[] {
  return [{ kind: 'text', text: 'done' } as StreamEvent, doneEvent(costUsd, 'end_turn')];
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
    const tool: RawToolOptions = {
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => 'ok',
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  },
};

type TurnEnd = Extract<HarnessEvent, { kind: 'turn_end' }>;

/** Drive `run()` over `turns` and collect every terminal turn_end. */
async function runTurns(opts: {
  rounds: StreamEvent[][];
  turns?: number;
  turnSpendCeilingUsd?: number;
  liveSpend?: LiveSpendLedger;
  outputFormat?: OutputFormat;
}): Promise<{ ends: TurnEnd[]; transport: ScriptTransport }> {
  const transport = new ScriptTransport(opts.rounds);
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost: noopToolHost,
    ...(opts.liveSpend !== undefined ? { liveSpend: opts.liveSpend } : {}),
    ...(opts.turnSpendCeilingUsd !== undefined ? { turnSpendCeilingUsd: opts.turnSpendCeilingUsd } : {}),
    ...(opts.outputFormat !== undefined ? { outputFormat: opts.outputFormat } : {}),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 'task-ceiling',
    sessionId: 's-ceiling',
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

/** Four priced rounds: three that call a tool, then a clean terminator. */
const FOUR_ROUNDS = (): StreamEvent[][] => [
  toolRound('t0', 0.04),
  toolRound('t1', 0.04),
  toolRound('t2', 0.04),
  textRound(0.04),
];

describe('parent round loop — the per-turn ceiling', () => {
  it('stops BEFORE the round whose head sees the ceiling reached, and says why', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends, transport } = await runTurns({
      rounds: FOUR_ROUNDS(),
      turnSpendCeilingUsd: 0.05,
      liveSpend,
    });

    // Round 1 head: $0 → runs ($0.04). Round 2 head: $0.04 < $0.05 → runs ($0.08).
    // Round 3 head: $0.08 >= $0.05 → TRIP, before the model call.
    expect(transport.calls).toBe(2);

    expect(ends).toHaveLength(1);
    const end = ends[0];
    expect(end.outcome.kind).toBe('max_budget');
    const outcome = end.outcome as Extract<typeof end.outcome, { kind: 'max_budget' }>;
    expect(outcome.triggeredBy).toBe('turn_ceiling');
    expect(outcome.raw.subtype).toBe('turn_spend_ceiling');
    expect(outcome.costUsd).toBeCloseTo(0.08, 9);
    expect(end.exitReason).toBe('turn_spend_ceiling');
    // A tool_use stopReason would make the driver skip finalization (BUG-1).
    expect(end.stopReason).not.toBe('tool_use');
  });

  it('books the money already spent — the trip is a stop, not a lost receipt', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends } = await runTurns({
      rounds: FOUR_ROUNDS(),
      turnSpendCeilingUsd: 0.05,
      liveSpend,
    });
    const end = ends[0];
    expect(end.billing?.cumulativeCostUsd).toBeCloseTo(0.08, 9);
    expect(end.billing?.turnDeltaUsd).toBeCloseTo(0.08, 9);
    expect(end.billing?.parentOwnCostUsd).toBeCloseTo(0.08, 9);
    expect(liveSpend.readTurnUsd()).toBeCloseTo(0.08, 9);
  });

  it('the ceiling is PER TURN — the next user message runs on a fresh baseline', async () => {
    const liveSpend = createLiveSpendLedger();
    // Every scripted round calls a tool, so only the ceiling can stop either turn.
    const { ends, transport } = await runTurns({
      rounds: [toolRound('t0', 0.04)],
      turns: 2,
      turnSpendCeilingUsd: 0.05,
      liveSpend,
    });
    // Two rounds per turn. A RUN-scoped reading would let turn 2 trip at its very
    // first head (run total already $0.08) and drive ZERO model calls.
    expect(transport.calls).toBe(4);
    expect(ends).toHaveLength(2);
    for (const end of ends) expect(end.exitReason).toBe('turn_spend_ceiling');
    expect(liveSpend.readUsd()).toBeCloseTo(0.16, 9);
    expect(liveSpend.readTurnUsd()).toBeCloseTo(0.08, 9);
  });

  it('is inert without the knob — the same script completes every round', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends, transport } = await runTurns({ rounds: FOUR_ROUNDS(), liveSpend });
    expect(transport.calls).toBe(4);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(ends[0].exitReason).not.toBe('turn_spend_ceiling');
  });

  it('never drives the structured-output epilogue — the gate is not a down payment on more calls', async () => {
    // The trip routes AROUND finalizeTurn, whose epilogue makes its own constrained
    // model call (plus retries). Route the trip THROUGH it instead and this same run
    // bills 5 calls, not 2 — three of them AFTER the ceiling said stop.
    // The schema must be inside the constrainable subset: an unconstrainable one
    // fail-closes at preflight, drives zero calls either way, and the test would pass
    // against a broken guard.
    const schema: OutputFormat = {
      type: 'json_schema',
      name: 'ans',
      schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] },
    };
    const liveSpend = createLiveSpendLedger();
    const { ends, transport } = await runTurns({
      rounds: FOUR_ROUNDS(),
      turnSpendCeilingUsd: 0.05,
      liveSpend,
      outputFormat: schema,
    });
    expect(transport.calls).toBe(2);
    expect(ends[0].exitReason).toBe('turn_spend_ceiling');
    expect(ends[0].billing?.cumulativeCostUsd).toBeCloseTo(0.08, 9);
  });

  it('is inert without a ledger — the knob alone gates nothing', async () => {
    const { ends, transport } = await runTurns({ rounds: FOUR_ROUNDS(), turnSpendCeilingUsd: 0.05 });
    expect(transport.calls).toBe(4);
    expect(ends[0].outcome.kind).toBe('completed');
  });
});

// ── the predicate ────────────────────────────────────────────────────────────

describe('turnSpendCeilingReached — the one predicate every site shares', () => {
  it('needs BOTH the knob and the ledger', () => {
    const liveSpend = createLiveSpendLedger();
    liveSpend.addUsd(1);
    expect(turnSpendCeilingReached({ liveSpend })).toBe(false);
    expect(turnSpendCeilingReached({ turnSpendCeilingUsd: 0.5 })).toBe(false);
    expect(turnSpendCeilingReached({ turnSpendCeilingUsd: 0.5, liveSpend })).toBe(true);
  });

  it('trips at the ceiling (>=), reads the TURN delta, and a ceiling of 0 trips at once', () => {
    const liveSpend = createLiveSpendLedger();
    expect(turnSpendCeilingReached({ turnSpendCeilingUsd: 0, liveSpend })).toBe(true);
    liveSpend.addUsd(0.5);
    expect(turnSpendCeilingReached({ turnSpendCeilingUsd: 0.5, liveSpend })).toBe(true);
    // A new turn starts clean even though the RUN total stands at $0.50.
    liveSpend.markTurnStart();
    expect(turnSpendCeilingReached({ turnSpendCeilingUsd: 0.5, liveSpend })).toBe(false);
  });
});

// ── the subagent loops ───────────────────────────────────────────────────────

/** A scripted subagent transport: every round calls a tool, so only a gate stops it. */
function subTransport(costPerRound: number[]): { transport: Transport; calls: () => number } {
  let calls = 0;
  let costIdx = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h, text) => {
      (h as unknown[]).push({ role: 'user', text });
    },
    pushAssistant: (h) => {
      (h as unknown[]).push({ role: 'assistant' });
    },
    pushToolResult: (h, r) => {
      (h as unknown[]).push({ role: 'tool', id: r.toolUseId });
    },
    buildTools: (raw) => raw as unknown[],
    defaultModel: () => 'fake-model',
    historyFromJournal: () => [] as unknown as ProviderHistory,
    callModel: () => {
      const i = calls++;
      const evs: StreamEvent[] = [
        { kind: 'text', text: `round-${i}` },
        { kind: 'tool_use', toolUse: { id: `tu-${i}`, name: 'noop', input: {} } } as StreamEvent,
        { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ];
      return evs as unknown as ProviderStream;
    },
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: () => costPerRound[costIdx++] ?? 0,
  };
  return { transport: t as Transport, calls: () => calls };
}

const passHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const noPause = async (): Promise<string> => 'PAUSED';

describe('subagent loops — a tripped child stops before its next model call', () => {
  for (const sharedLoop of [false, true]) {
    it(`${sharedLoop ? 'shared' : 'legacy'} loop — stops at the head and settles what it spent`, async () => {
      const liveSpend = createLiveSpendLedger();
      const gate = { turnSpendCeilingUsd: 0.05, liveSpend };
      const { transport, calls } = subTransport([0.04, 0.04, 0.04, 0.04, 0.04, 0.04]);
      const res = await runSubagentLoop({
        transport,
        model: 'fake-model',
        system: 's',
        userPrompt: 'p',
        tools: [],
        harness: passHarness,
        onPause: noPause,
        maxTurns: 6,
        onEvent: () => {},
        childId: 'child-1',
        sharedLoop,
        liveSpend,
        turnSpendExceeded: () => turnSpendCeilingReached(gate),
      });
      // Two rounds ran; the third head saw $0.08 >= $0.05 and stopped.
      expect(calls()).toBe(2);
      // Money spent is money booked — the child's total still folds to the parent.
      expect(res.costUsd).toBeCloseTo(0.08, 9);
      expect(res.childCost.costUsd).toBeCloseTo(0.08, 9);
      expect(liveSpend.readUsd()).toBeCloseTo(0.08, 9);
      // The parent is told WHY the answer is partial (else it just spawns another child).
      expect(res.text).toContain('turn spend ceiling');
    });

    it(`${sharedLoop ? 'shared' : 'legacy'} loop — inert without the closure`, async () => {
      const { transport, calls } = subTransport([0.04, 0.04, 0.04, 0.04, 0.04, 0.04]);
      const res = await runSubagentLoop({
        transport,
        model: 'fake-model',
        system: 's',
        userPrompt: 'p',
        tools: [],
        harness: passHarness,
        onPause: noPause,
        maxTurns: 6,
        onEvent: () => {},
        childId: 'child-1',
        sharedLoop,
      });
      expect(calls()).toBe(6);
      expect(res.costUsd).toBeCloseTo(0.24, 9);
      expect(res.text).not.toContain('turn spend ceiling');
    });
  }
});

// ── the launch gate ──────────────────────────────────────────────────────────

describe('fanOutChildren — the launch gate refuses to start new children', () => {
  it('skips every child scheduled after the ceiling is reached', async () => {
    let exceeded = false;
    const launched: number[] = [];
    const results = await fanOutChildren(['a', 'b', 'c'], {
      turnSpendExceeded: () => exceeded,
      onLaunch: (i) => launched.push(i),
      runChild: async (_spec, i) => {
        if (i === 0) exceeded = true; // the first child burns through the ceiling
        return { text: `ran ${i}`, pausedHalt: false };
      },
    });
    expect(launched).toEqual([0]);
    expect(results[0].text).toBe('ran 0');
    expect(results[1].text).toBe('Skipped: turn spend ceiling reached.');
    expect(results[2].text).toBe('Skipped: turn spend ceiling reached.');
  });

  it('is inert without the closure — every child launches', async () => {
    const launched: number[] = [];
    const results = await fanOutChildren(['a', 'b'], {
      onLaunch: (i) => launched.push(i),
      runChild: async (_spec, i) => ({ text: `ran ${i}`, pausedHalt: false }),
    });
    expect(launched).toEqual([0, 1]);
    expect(results.map((r) => r.text)).toEqual(['ran 0', 'ran 1']);
  });
});

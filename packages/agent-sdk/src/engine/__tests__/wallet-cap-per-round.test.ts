/**
 * The WALLET CAP inside the round loop (founder 09-03, credits first-class).
 *
 * `maxBudgetUsd` is minted per message from the LIVE balance — "what the account can
 * afford from here". Until now it was read ONCE, at the turn head (openTurn), right
 * after `markTurnStart()` zeroed the turn's spend — so it compared $0 against the cap
 * and could only trip when the cap itself was $0. A funded-but-thin turn then ran
 * unbounded: four staging drills spent 2.5× a $0.01 cap and ended `completed`, and a
 * 51-step production turn ran past zero. The per-turn CEILING already has the right
 * discipline (turn-ceiling-gate.ts: check at every round head, stop BEFORE the next
 * model call, finalize recoverable). The wallet cap now shares it.
 *
 * Same scaffolding as turn-spend-ceiling.test.ts: scripted priced rounds, a noop tool
 * so the loop would iterate again, a live ledger the gate reads.
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
type MaxBudget = Extract<TurnEnd['outcome'], { kind: 'max_budget' }>;

/** Drive `run()` over `turns` and collect every terminal turn_end. */
async function runTurns(opts: {
  rounds: StreamEvent[][];
  turns?: number;
  maxBudgetUsd?: number;
  maxBudgetSource?: 'credits' | 'task_limit';
  getBudgetMint?: () => { usd?: number; source?: 'credits' | 'task_limit' };
  turnSpendCeilingUsd?: number;
  liveSpend?: LiveSpendLedger;
}): Promise<{ ends: TurnEnd[]; transport: ScriptTransport }> {
  const transport = new ScriptTransport(opts.rounds);
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost: noopToolHost,
    ...(opts.liveSpend !== undefined ? { liveSpend: opts.liveSpend } : {}),
    ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    ...(opts.maxBudgetSource !== undefined ? { maxBudgetSource: opts.maxBudgetSource } : {}),
    ...(opts.getBudgetMint !== undefined ? { getBudgetMint: opts.getBudgetMint } : {}),
    ...(opts.turnSpendCeilingUsd !== undefined ? { turnSpendCeilingUsd: opts.turnSpendCeilingUsd } : {}),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 'task-wallet',
    sessionId: 's-wallet',
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

describe('parent round loop — the wallet cap, checked at every round head', () => {
  it('stops BEFORE the round whose head sees the cap reached — the wallet, not "done"', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends, transport } = await runTurns({
      rounds: FOUR_ROUNDS(),
      maxBudgetUsd: 0.05,
      maxBudgetSource: 'credits',
      liveSpend,
    });

    // Round 1 head: $0 → runs ($0.04). Round 2 head: $0.04 < $0.05 → runs ($0.08).
    // Round 3 head: $0.08 >= $0.05 → TRIP, before the model call. (Under the
    // turn-head-only reading every one of the four rounds ran.)
    expect(transport.calls).toBe(2);

    expect(ends).toHaveLength(1);
    const end = ends[0];
    expect(end.outcome.kind).toBe('max_budget');
    const outcome = end.outcome as MaxBudget;
    expect(outcome.triggeredBy).toBe('credits');
    expect(outcome.raw.subtype).toBe('max_budget');
    expect(outcome.costUsd).toBeCloseTo(0.08, 9);
    expect(end.exitReason).toBe('max_budget');
    // A tool_use stopReason would make the driver skip finalization (BUG-1).
    expect(end.stopReason).not.toBe('tool_use');
  });

  it("names the user's own per-task limit when THAT minted the cap", async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends } = await runTurns({
      rounds: FOUR_ROUNDS(),
      maxBudgetUsd: 0.05,
      maxBudgetSource: 'task_limit',
      liveSpend,
    });
    expect((ends[0].outcome as MaxBudget).triggeredBy).toBe('task_limit');
  });

  it('reads the LIVE mint first — a warm run adopts the freshest frame, not its construction snapshot', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends, transport } = await runTurns({
      rounds: FOUR_ROUNDS(),
      maxBudgetUsd: 10, // the stale static would never trip
      maxBudgetSource: 'task_limit',
      getBudgetMint: () => ({ usd: 0.05, source: 'credits' }),
      liveSpend,
    });
    expect(transport.calls).toBe(2);
    expect((ends[0].outcome as MaxBudget).triggeredBy).toBe('credits');
  });

  it('books the money already spent — the trip is a stop, not a lost receipt', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends } = await runTurns({ rounds: FOUR_ROUNDS(), maxBudgetUsd: 0.05, liveSpend });
    const end = ends[0];
    expect(end.billing?.cumulativeCostUsd).toBeCloseTo(0.08, 9);
    expect(end.billing?.turnDeltaUsd).toBeCloseTo(0.08, 9);
    expect(liveSpend.readTurnUsd()).toBeCloseTo(0.08, 9);
  });

  it('the cap is NEW spend per turn — the next user message runs on a fresh baseline', async () => {
    const liveSpend = createLiveSpendLedger();
    // Every scripted round calls a tool, so only the cap can stop either turn.
    const { ends, transport } = await runTurns({
      rounds: [toolRound('t0', 0.04)],
      turns: 2,
      maxBudgetUsd: 0.05,
      liveSpend,
    });
    // Two rounds per turn. A RUN-scoped reading would let turn 2 trip at its very
    // first head (run total already $0.08) and drive ZERO model calls.
    expect(transport.calls).toBe(4);
    expect(ends).toHaveLength(2);
    for (const end of ends) expect(end.exitReason).toBe('max_budget');
  });

  it('the ceiling still wins its own name when both would trip at the same head', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends } = await runTurns({
      rounds: FOUR_ROUNDS(),
      maxBudgetUsd: 0.05,
      turnSpendCeilingUsd: 0.05,
      liveSpend,
    });
    const outcome = ends[0].outcome as MaxBudget;
    expect(outcome.triggeredBy).toBe('turn_ceiling');
    expect(outcome.raw.subtype).toBe('turn_spend_ceiling');
  });

  it('is inert without the knob — the same script completes every round', async () => {
    const liveSpend = createLiveSpendLedger();
    const { ends, transport } = await runTurns({ rounds: FOUR_ROUNDS(), liveSpend });
    expect(transport.calls).toBe(4);
    expect(ends[0].outcome.kind).not.toBe('max_budget');
  });
});

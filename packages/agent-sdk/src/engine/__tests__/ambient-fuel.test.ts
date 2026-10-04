/**
 * P4 Task 2 — the AMBIENT fuel tank. A self-initiated (origin.kind === 'initiative')
 * turn bills a SEPARATE per-process bucket (`ambientFuelTankUsd`) so a runaway
 * anticipation loop can never eat the user's FOREGROUND capability. Checked at the turn
 * head BEFORE any model call: exhausted → the initiative turn finalizes `max_budget` +
 * `exitReason:'ambient_fuel_exhausted'` with ZERO model calls, and the run CONTINUES so
 * the next (human) turn is untouched.
 *
 * Axes (gated-feature discipline): flag-ON deny + run + ledger-accumulate; flag-OFF
 * (knob absent) → initiative turn runs byte-identical; origin-gated (a human turn never
 * trips the ambient gate even under a tiny ceiling).
 */
import { describe, it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { defaultNodeReserveUsd, _resetFuelTanksForTest, _tankKeysForTest } from '../fuel-tank.js';
import { resolveCapabilities } from '../../contract/model-capabilities.js';
import type { HarnessContext, UserTurn, MessageOrigin } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';

const MODEL = 'claude-sonnet-4-6';
const RESERVE = defaultNodeReserveUsd(MODEL, resolveCapabilities(MODEL).maxOutputTokens);

const INITIATIVE: MessageOrigin = {
  kind: 'initiative',
  trigger: { kind: 'scheduled', scheduleId: 'r1', firedAt: '2026-07-04T00:00:00Z' },
  politeness: 'silent-unless-actionable',
};
const HUMAN: MessageOrigin = { kind: 'human' };

function doneEvent(costUsd: number): StreamEvent {
  return { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, costUsd } as NormalizedUsage };
}

/** One text round per model call, priced off `usage.costUsd`; counts callModel. */
class CountingTransport extends FakeTransport {
  calls = 0;
  constructor(private readonly roundCostUsd: number) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    this.calls += 1;
    return [{ kind: 'text', text: 'ok' }, doneEvent(this.roundCostUsd)];
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

const emptyToolHost: ToolHost = { buildTools: async () => ({ tools: [], onAuthHalt: async () => {} }) };

function buildCtx(transport: FakeTransport, ambientFuelTankUsd?: number): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost: emptyToolHost,
    ...(ambientFuelTankUsd !== undefined && { ambientFuelTankUsd }),
  } as unknown as NativeConfig;
  return { taskId: 'amb-t', sessionId: 'amb-s', cwd: '/tmp', model: MODEL, signal: new AbortController().signal, config: cfg };
}

async function runTurns(
  turns: UserTurn[],
  opts: { ambientFuelTankUsd?: number; roundCostUsd?: number },
): Promise<{ ends: Array<Extract<HarnessEvent, { kind: 'turn_end' }>>; calls: number }> {
  _resetFuelTanksForTest();
  const transport = new CountingTransport(opts.roundCostUsd ?? RESERVE);
  const ctx = buildCtx(transport, opts.ambientFuelTankUsd);
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    for (const t of turns) yield t;
  })();
  const ends: Array<Extract<HarnessEvent, { kind: 'turn_end' }>> = [];
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'turn_end') ends.push(ev as Extract<HarnessEvent, { kind: 'turn_end' }>);
  }
  return { ends, calls: transport.calls };
}

describe('Ambient fuel tank — initiative turns bill a capped, separate bucket (P4 T2)', () => {
  it('exhausted ceiling: an initiative turn is DENIED before any model call; the next human turn runs', async () => {
    const { ends, calls } = await runTurns([
      { text: 'ambient work', origin: INITIATIVE },
      { text: 'hello', origin: HUMAN },
    ], { ambientFuelTankUsd: RESERVE * 0.5 }); // below one reserve → deny turn 1

    expect(ends).toHaveLength(2);
    // Turn 1 (initiative) denied at $0, no model call.
    expect(ends[0].outcome.kind).toBe('max_budget');
    expect(ends[0].exitReason).toBe('ambient_fuel_exhausted');
    expect(ends[0].billing!.cumulativeCostUsd).toBe(0);
    // Turn 2 (human) ran normally — exactly ONE model call total (only the human turn).
    expect(ends[1].outcome.kind).toBe('completed');
    expect(calls).toBe(1);
  });

  it('generous ceiling: the initiative turn RUNS; the run-local ledger then denies a SECOND initiative turn', async () => {
    // Ceiling fits ~1 turn: turn 1 admits (remaining ≥ reserve) and spends RESERVE, so
    // the ledger (ambientSpentUsd) leaves remaining < reserve → turn 2 denied.
    const ceiling = RESERVE * 1.5;
    const { ends, calls } = await runTurns([
      { text: 'ambient 1', origin: INITIATIVE },
      { text: 'ambient 2', origin: INITIATIVE },
    ], { ambientFuelTankUsd: ceiling, roundCostUsd: RESERVE });

    expect(ends).toHaveLength(2);
    expect(ends[0].outcome.kind).toBe('completed'); // turn 1 ran
    expect(ends[1].outcome.kind).toBe('max_budget'); // turn 2 denied by the accumulated ledger
    expect(ends[1].exitReason).toBe('ambient_fuel_exhausted');
    expect(calls).toBe(1); // only turn 1 called the model
  });

  it('flag-OFF (knob absent): an initiative turn runs byte-identical — no ambient gate, no ambient tank', async () => {
    const { ends, calls } = await runTurns([{ text: 'ambient', origin: INITIATIVE }], {});
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(calls).toBe(1);
    // No ambient tank was ever created for this task.
    expect(_tankKeysForTest()).not.toContain('amb-t#ambient');
  });

  it('origin-gated: a HUMAN turn under a tiny ambient ceiling still runs (ambient gate is initiative-only)', async () => {
    const { ends, calls } = await runTurns([{ text: 'hello', origin: HUMAN }], { ambientFuelTankUsd: RESERVE * 0.5 });
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(calls).toBe(1);
  });
});

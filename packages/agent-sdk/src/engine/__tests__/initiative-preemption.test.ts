/**
 * P4 Task 3 — PREEMPTION: a human turn always wins. During an INITIATIVE turn, at each
 * round boundary (the same safe boundary the steer consult uses, BEFORE it), the loop
 * checks `cfg.hasPendingInput?.()`; a staged human turn finalizes the initiative turn NOW
 * as `completed` with `exitReason:'preempted_by_human'` and the next model round never
 * runs. The staged human turn is then picked up as a fresh turn (not modelled here — the
 * mocked input yields a single turn). Preemption is initiative-only: a human turn with
 * pending input does NOT early-exit.
 */
import { describe, it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { _resetFuelTanksForTest } from '../fuel-tank.js';
import type { HarnessContext, UserTurn, MessageOrigin } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

const MODEL = 'claude-sonnet-4-6';
const INITIATIVE: MessageOrigin = {
  kind: 'initiative',
  trigger: { kind: 'scheduled', scheduleId: 'r1', firedAt: '2026-07-04T00:00:00Z' },
  politeness: 'silent-unless-actionable',
};
const HUMAN: MessageOrigin = { kind: 'human' };

function done(stopReason: string): StreamEvent {
  // A tiny positive cost keeps the completed turn above the billing tripwire (a $0
  // completed turn that made a model call warns; irrelevant to preemption).
  return { kind: 'done', stopReason, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.001 } as NormalizedUsage };
}

/**
 * Round 1 emits a tool_use (so the loop reaches a round boundary + iterates); round 2 is
 * a plain text completion. Counts callModel so a preempt (break before round 2) is
 * observable as calls === 1.
 */
class TwoRoundTransport extends FakeTransport {
  calls = 0;
  constructor() {
    super([]);
  }
  override callModel(): StreamEvent[] {
    this.calls += 1;
    if (this.calls === 1) {
      return [{ kind: 'tool_use', toolUse: { id: 'tu-1', name: 'Note', input: {} } }, done('tool_use')];
    }
    return [{ kind: 'text', text: 'round 2' }, done('end_turn')];
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

const noteToolHost: ToolHost = {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool: RawToolOptions = {
      name: 'Note',
      description: 'a no-op tool so round 1 emits a tool_use',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => 'noted',
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  },
};

async function runOne(
  origin: MessageOrigin,
  hasPendingInput: (() => boolean) | undefined,
): Promise<{ ends: Array<Extract<HarnessEvent, { kind: 'turn_end' }>>; calls: number }> {
  _resetFuelTanksForTest();
  const transport = new TwoRoundTransport();
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost: noteToolHost,
    ...(hasPendingInput !== undefined && { hasPendingInput }),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 'pre-t', sessionId: 'pre-s', cwd: '/tmp', model: MODEL, signal: new AbortController().signal, config: cfg,
  };
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go', origin };
  })();
  const ends: Array<Extract<HarnessEvent, { kind: 'turn_end' }>> = [];
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'turn_end') ends.push(ev as Extract<HarnessEvent, { kind: 'turn_end' }>);
  }
  return { ends, calls: transport.calls };
}

describe('Initiative preemption — a human turn always wins (P4 T3)', () => {
  it('an initiative turn with pending input finalizes completed + preempted_by_human; round 2 never calls the model', async () => {
    // hasPendingInput is true at the round-1 boundary (after the first model call).
    const { ends, calls } = await runOne(INITIATIVE, () => true);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(ends[0].exitReason).toBe('preempted_by_human');
    expect(calls).toBe(1); // round 2's model call never happened
  });

  it('a HUMAN turn with pending input does NOT preempt — it runs both rounds to normal completion', async () => {
    const { ends, calls } = await runOne(HUMAN, () => true);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(ends[0].exitReason).not.toBe('preempted_by_human');
    expect(calls).toBe(2); // both rounds ran — preemption is initiative-only
  });

  it('an initiative turn with NO pending input runs normally (no false preemption)', async () => {
    const { ends, calls } = await runOne(INITIATIVE, () => false);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(ends[0].exitReason).not.toBe('preempted_by_human');
    expect(calls).toBe(2);
  });
});

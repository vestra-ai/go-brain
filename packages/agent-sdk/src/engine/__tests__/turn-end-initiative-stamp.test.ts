/**
 * P4 Task 4 — the terminal `turn_end` carries an `initiative` stamp IFF the turn was
 * self-initiated (`origin.kind === 'initiative'`). A human/default turn carries NO
 * `initiative` key at all — byte-identical wire shape (the exitReason?/paused?
 * additive-optional precedent). The stamp is derived from `userTurn.origin` and rides
 * `terminalTurnEnd`, so every terminal path (normal completion, refused, warm /compact)
 * classifies uniformly.
 */
import { it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type { HarnessContext, UserTurn, MessageOrigin } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

// ── scripted transport ────────────────────────────────────────────────────────

function doneEvent(costUsd: number): StreamEvent {
  return {
    kind: 'done',
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, costUsd } as NormalizedUsage,
  };
}

/** A transport that serves one scripted round then a clean terminator. */
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

function buildCtx(transport: FakeTransport): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
  } as unknown as NativeConfig;
  return { taskId: 't4', sessionId: 's4', cwd: '/tmp', model: 'fake-model', signal: new AbortController().signal, config: cfg };
}

/** Drive one real turn through run() with the given origin; return the terminal turn_end. */
async function runTurnWith(origin?: MessageOrigin): Promise<Extract<HarnessEvent, { kind: 'turn_end' }>> {
  const transport = new ScriptTransport([[{ kind: 'text', text: 'ok' }, doneEvent(0)]]);
  const ctx = buildCtx(transport);
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go', ...(origin ? { origin } : {}) };
  })();

  let last: Extract<HarnessEvent, { kind: 'turn_end' }> | undefined;
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'turn_end') last = ev as Extract<HarnessEvent, { kind: 'turn_end' }>;
  }
  if (!last) throw new Error('no turn_end emitted');
  return last;
}

const INITIATIVE_ORIGIN: MessageOrigin = {
  kind: 'initiative',
  trigger: { kind: 'scheduled', scheduleId: 'routine-abc', firedAt: '2026-07-04T00:00:00.000Z' },
  politeness: 'silent-unless-actionable',
};

it('stamps turn_end.initiative from an initiative origin', async () => {
  const ev = await runTurnWith(INITIATIVE_ORIGIN);
  expect(ev.initiative).toEqual({
    trigger: { kind: 'scheduled', scheduleId: 'routine-abc', firedAt: '2026-07-04T00:00:00.000Z' },
    politeness: 'silent-unless-actionable',
  });
});

it('omits the initiative key entirely on a human/default turn (byte-identical shape)', async () => {
  const ev = await runTurnWith(); // no origin
  expect('initiative' in ev).toBe(false);
});

it('omits the initiative key for a non-initiative origin (e.g. human)', async () => {
  const ev = await runTurnWith({ kind: 'human' });
  expect('initiative' in ev).toBe(false);
});

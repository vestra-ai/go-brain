/**
 * L5 conformance — the turn's owner (turn-budget.ts) changes nothing on any wire.
 *
 * Every recorded run replays through the real kernel loop once per wire format (Anthropic
 * Messages, OpenAI Responses, Chat Completions, Gemini, Gemini Interactions), once
 * without a budget and once with one minted the way the driver mints it. The two passes
 * must send the same request bodies, write the same journal and yield the same events;
 * the budget must have recorded an end and never aborted its root.
 */
import { describe, expect, it } from 'vitest';
import { replaySession, type ReplaySessionResult } from '../../src/engine/replay/replay-session.js';
import { createTurnBudget, type TurnBudget } from '../../src/engine/turn-budget.js';
import type { JournalEntry } from '../../src/contract/journal.js';
import type { HarnessEvent } from '../../src/contract/events.js';
import { LANES, listFixtures, type Fixture, type Lane } from '../fixtures.js';
import { BenchTransport } from '../wire.js';

/** Ids, sequence and wall-clock fields are volatile across two replays; the rest is behaviour. */
const VOLATILE = new Set(['uuid', 'parentUuid', 'seq', 'timestamp', 'startTime', 'endTime', 'durationMs', 'ttftMs', 'latencyMs', 'firstTextMs', 'beforeSendMs', 'afterSendMs']);
const stable = (v: JournalEntry[] | HarnessEvent[]): unknown =>
  JSON.parse(JSON.stringify(v), (k, x) => (VOLATILE.has(k) ? undefined : x));

async function replay(fixture: Fixture, lane: Lane, budget?: TurnBudget): Promise<{ result: ReplaySessionResult; bodies: string[] }> {
  let bench: BenchTransport | undefined;
  const result = await replaySession(fixture.path, {
    model: lane.model,
    // A cross-dialect mismatch is the bench's finding to report, not this test's subject.
    reconstructionCheck: 'warn',
    transport: (r) => (bench = new BenchTransport(lane.wire, r)),
    ...(budget ? { budget } : {}),
  });
  if (!bench) throw new Error('the replay never built its transport');
  return { result, bodies: bench.bodies };
}

describe('TurnBudget × every wire format × every recorded run: byte-identical', () => {
  const cases = LANES.flatMap((lane) => listFixtures().map((fixture) => ({ lane, fixture })));

  it.each(cases.map((c) => [`${c.lane.wire} ${c.fixture.name}`, c] as const))('%s', async (_name, { lane, fixture }) => {
    const plain = await replay(fixture, lane);
    const budget = createTurnBudget({ maxRounds: 200 });
    const owned = await replay(fixture, lane, budget);

    // Mutation: any field, frame or request the owner adds or moves shows up here.
    expect(owned.bodies).toEqual(plain.bodies);
    expect(stable(owned.result.journal)).toEqual(stable(plain.result.journal));
    expect(stable(owned.result.events)).toEqual(stable(plain.result.events));
    expect(owned.result.mismatches.length).toBe(plain.result.mismatches.length);

    // The owner saw the run end and never cut it.
    expect(budget.signal.aborted).toBe(false);
    expect(budget.ended).not.toBeNull();
    expect(budget.rounds).toBeGreaterThan(0);
  }, 60_000);
});

/**
 * POST_TURN_OFF_PATH_V1 — a follow-up never waits on post-turn work.
 *
 * Today the loop awaits the next-prompt suggestion and then the Nami memory sweep
 * before it reads the next message. Measured on staging (15 Sep to 1 Oct): 22 of 49
 * quick follow-ups arrived in that window and waited 3.8 s p50 / 7.8 s p90 before
 * their turn could even start.
 *
 * Every timed case drives the REAL harness over a real Journal. The two side calls
 * take 5 s each on a fake clock (the transport sleeps on fake setTimeout and honours
 * abort); the follow-up lands either while the suggestion runs (+1 s) or while the
 * sweep runs (+6 s). Waiting is `pumpUntil`: a condition with a WALL-CLOCK deadline,
 * never a fixed number of fake-clock steps, and every timer the code under test arms
 * is proven armed before the clock moves past it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type ProviderStream, type StreamEvent } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { SUGGESTION_SYSTEM } from '../../contract/suggestion-prompt.js';
import { MEMORY_SWEEP_PROMPT } from '../memory-sweep.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent, NormalizedUsage } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

// Every duration the engine measures (round timings, side-call wall time) reads the monotonic
// clock; here it reads the fake one the whole file runs on, so two runs measure the same.
vi.mock('../monotonic-clock.js', () => ({ monotonicMs: () => Date.now() }));

const FLAG = 'POST_TURN_OFF_PATH_V1';
const SIDE_MS = 5_000;
const CHIP = 'prompt:suggestion';
const DEPOSIT = 'nami:remember_deposit';
const PUMP_DEADLINE_MS = 10_000;

beforeEach(() => {
  // Only the clock the code under test waits on. setImmediate stays real so the
  // journal's fs callbacks land; performance.now stays real for pump deadlines.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env[FLAG];
});

/** Wait for a condition: microtasks + zero-delay fake timers, then one real I/O turn. */
async function pumpUntil(ready: () => boolean, awaited: string): Promise<void> {
  const giveUpAt = performance.now() + PUMP_DEADLINE_MS;
  while (!ready()) {
    if (performance.now() >= giveUpAt) {
      throw new Error(`pumpUntil gave up after ${PUMP_DEADLINE_MS}ms waiting for ${awaited} (the fake clock did not move here: a stall in the code under test)`);
    }
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Let everything that can run without the clock moving run (a bounded number of real I/O turns). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type Role = 'main' | 'suggestion' | 'sweep';
interface Call {
  role: Role;
  at: number;
  signal?: AbortSignal;
  reasoningEffort?: 'low';
  aborted?: boolean;
  returned?: boolean;
}

const REPLIES: Record<Role, StreamEvent[]> = {
  main: [
    { kind: 'text', text: 'Done.' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 40 } },
  ],
  suggestion: [
    { kind: 'text', text: 'want me to email it?' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 2_100, outputTokens: 9 } },
  ],
  sweep: [
    { kind: 'text', text: 'FACT [identity] The user builds Vestra.' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 55, cacheReadInputTokens: 41_000 } },
  ],
};

/**
 * A fake-clock sleep that rejects like a real provider stream when its request is aborted,
 * `abortSettleMs` (fake) after the abort: a transport that is slow to let go.
 */
function sleep(ms: number, signal?: AbortSignal, abortSettleMs = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    if (signal?.aborted) return reject(aborted());
    const onAbort = () => {
      clearTimeout(timer);
      if (abortSettleMs > 0) setTimeout(() => reject(aborted()), abortSettleMs);
      else reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface TimedOpts {
  /** Fake ms a role's stream takes to reject after its abort (default: at once). */
  abortSettleMs?: Partial<Record<Role, number>>;
  /** Fake ms a role's stream stays open AFTER yielding its `done` (its usage is already reported). */
  tailAfterDone?: Partial<Record<Role, number>>;
  /** Told of every call as it is made. */
  onCall?: (role: Role) => void;
}

/** Tells the three calls apart by what they send, and takes `delays[role]` (fake ms) to answer. */
class TimedTransport extends FakeTransport {
  calls: Call[] = [];
  /** Side calls currently waiting on the fake clock: the clock only moves when this is > 0. */
  sleeping = 0;
  constructor(
    private readonly delays: Record<Role, number>,
    private readonly opts: TimedOpts = {},
  ) {
    super([]);
  }
  /** One fake-clock wait of `call`, counted in `sleeping`; an abort marks the call aborted. */
  private async wait(call: Call, ms: number): Promise<void> {
    this.sleeping += 1;
    try {
      await sleep(ms, call.signal, this.opts.abortSettleMs?.[call.role] ?? 0);
    } catch (err) {
      call.aborted = true;
      throw err;
    } finally {
      this.sleeping -= 1;
    }
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): ProviderStream {
    super.callModel(p);
    const last = (p.history as Array<{ text?: string }>).at(-1);
    const role: Role = p.system === SUGGESTION_SYSTEM ? 'suggestion' : last?.text === MEMORY_SWEEP_PROMPT ? 'sweep' : 'main';
    const call: Call = { role, at: Date.now(), ...(p.signal && { signal: p.signal }), ...(p.reasoningEffort && { reasoningEffort: p.reasoningEffort }) };
    this.calls.push(call);
    this.opts.onCall?.(role);
    return call as unknown as ProviderStream;
  }
  override async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const call = stream as unknown as Call;
    if (this.delays[call.role] > 0) await this.wait(call, this.delays[call.role]);
    yield* REPLIES[call.role];
    const tail = this.opts.tailAfterDone?.[call.role] ?? 0;
    if (tail > 0) await this.wait(call, tail);
    call.returned = true;
  }
  override computeCostUsd(u: NormalizedUsage): number {
    return (u.inputTokens + u.outputTokens) / 1_000_000;
  }
  of(role: Role): Call[] {
    return this.calls.filter((c) => c.role === role);
  }
}

/**
 * The lane's two faces the harness sees: a pull that resolves when a message is
 * sent to a WAITING loop, and `hasPendingInput` (the staged count) when it is busy.
 */
function turnQueue() {
  const items: UserTurn[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* gen(): AsyncGenerator<UserTurn> {
    for (;;) {
      if (items.length > 0) {
        yield items.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  }
  return {
    iterable: gen(),
    push(text: string, extra: Partial<UserTurn> = {}) {
      items.push({ text, ...extra });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    pending: () => items.length > 0,
  };
}

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `post-turn-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

interface Session {
  events: HarnessEvent[];
  transport: TimedTransport;
  journal: Journal;
  queue: ReturnType<typeof turnQueue>;
  done: () => boolean;
  /** What run() threw, if it threw. */
  error: () => unknown;
  /** Every slow cut the harness reported (cfg.onPostTurnCut). */
  cuts: Array<{ lane: string; settleMs: number }>;
  /** How many turn_end events had been yielded when the first side call was made. */
  turnEndsAtFirstSideCall: () => number | undefined;
}

interface SessionOpts {
  transport?: Omit<TimedOpts, 'onCall'>;
  /** The run's abort signal (cfg.signal and ctx.signal). */
  signal?: AbortSignal;
  /** An input to drive instead of the session's own queue. */
  input?: AsyncIterable<UserTurn>;
  /** The host's box hold (cfg.holdForPostTurnWork). */
  hold?: () => () => void;
}

/** Start one session's run in the background, collecting every event it yields. */
function startSession(taskId: string, delays: Record<Role, number>, opts: SessionOpts = {}): Session {
  const events: HarnessEvent[] = [];
  let firstSide: number | undefined;
  const transport = new TimedTransport(delays, {
    ...opts.transport,
    onCall: (role) => {
      if (role !== 'main' && firstSide === undefined) firstSide = turnEnds(events).length;
    },
  });
  const journal = makeJournal(taskId);
  const queue = turnQueue();
  const cuts: Session['cuts'] = [];
  const cfg = {
    onAttached: () => {},
    maxTurns: 4,
    transport,
    journal,
    workingDir: join(tmpdir(), `post-turn-wd-${process.pid}-${Math.random().toString(36).slice(2)}`),
    suggestNextPrompt: true,
    namiOffloopSweep: true,
    hasPendingInput: queue.pending,
    onPostTurnCut: (cut: { lane: string; settleMs: number }) => cuts.push(cut),
    ...(opts.signal && { signal: opts.signal }),
    ...(opts.hold && { holdForPostTurnWork: opts.hold }),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId,
    sessionId: `s-${taskId}`,
    cwd: '/tmp',
    model: 'fake-model',
    signal: opts.signal ?? new AbortController().signal,
    config: cfg,
  };
  let finished = false;
  let thrown: unknown;
  void (async () => {
    try {
      for await (const e of new NativeHarness().run(opts.input ?? queue.iterable, ctx)) events.push(e);
    } catch (err) {
      thrown = err;
    } finally {
      finished = true;
    }
  })();
  return {
    events, transport, journal, queue, cuts,
    done: () => finished,
    error: () => thrown,
    turnEndsAtFirstSideCall: () => firstSide,
  };
}

/**
 * Close the input(s) and let every run end: the clock moves ONLY while a side call is
 * waiting on it, one side-call period at a time, so it can never jump past an unarmed
 * timer. A run left with nothing to wait on and still not done fails the pump.
 */
async function finish(...sessions: Session[]): Promise<void> {
  for (const s of sessions) s.queue.close();
  await drain(...sessions);
}

/** Let every run end on its own (its input already ended or will throw), moving the clock as finish does. */
async function drain(...sessions: Session[]): Promise<void> {
  while (!sessions.every((s) => s.done())) {
    await pumpUntil(
      () => sessions.every((s) => s.done()) || sessions.some((s) => s.transport.sleeping > 0),
      'every run to end or wait on a side call',
    );
    if (sessions.some((s) => s.transport.sleeping > 0)) await vi.advanceTimersByTimeAsync(SIDE_MS);
  }
}

const turnEnds = (events: HarnessEvent[]) => events.filter((e) => e.kind === 'turn_end');
const lane = (events: HarnessEvent[], name: string) =>
  events.filter((e): e is Extract<HarnessEvent, { kind: 'usage' }> => e.kind === 'usage' && e.lane === name);
const raws = (events: HarnessEvent[], name: string) =>
  events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === name);
const isSide = (e: HarnessEvent) =>
  (e.kind === 'usage' && (e.lane === 'suggestion' || e.lane === 'sweep')) ||
  (e.kind === 'raw' && [CHIP, DEPOSIT].includes((e as { event?: string }).event ?? ''));

/** Every side event sits in an unbroken run of side events right after a turn_end. */
function sideEventsOnlyBetweenTurns(events: HarnessEvent[]): boolean {
  return events.every((e, i) => {
    if (!isSide(e)) return true;
    for (let j = i - 1; j >= 0; j--) {
      if (events[j].kind === 'turn_end') return true;
      if (!isSide(events[j])) return false;
    }
    return false;
  });
}

/** What a resume replays: the journal's entries, payloads only, in order. */
async function journalPayloads(j: Journal): Promise<unknown[]> {
  await j.fsync();
  return (await j.snapshot()).map((e) => e.payload);
}

/**
 * Drive one full exchange: turn 1, a follow-up `followUpAtMs` after turn 1's turn_end,
 * then turn 2 and its own side calls, then the input closes. Returns the follow-up's
 * start latency: fake ms from the follow-up being sent to turn 2's model request.
 */
async function exchange(
  flagOn: boolean,
  followUpAtMs: number,
  taskId: string,
  followUp = 'also add the EU numbers',
  transport: SessionOpts['transport'] = {},
) {
  if (flagOn) process.env[FLAG] = 'true';
  else delete process.env[FLAG];
  const s = startSession(taskId, { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS }, { transport });

  s.queue.push('build me the quarterly report');
  await pumpUntil(() => turnEnds(s.events).length === 1, 'turn 1 turn_end');
  const turnEndAt = Date.now();
  // Arm before moving the clock: a side call's sleep starts once its request is made.
  const armed = (role: Role, n: number) => () => s.transport.of(role).length === n && s.transport.sleeping === 1;
  await pumpUntil(armed('suggestion', 1), 'the turn 1 suggestion, waiting');
  if (followUpAtMs > SIDE_MS) {
    await vi.advanceTimersByTimeAsync(SIDE_MS);
    await pumpUntil(armed('sweep', 1), 'the turn 1 sweep, waiting');
    await vi.advanceTimersByTimeAsync(followUpAtMs - SIDE_MS);
  } else {
    await vi.advanceTimersByTimeAsync(followUpAtMs);
  }
  const eventsBeforeFollowUp = s.events.length;
  s.queue.push(followUp);
  const sentAt = Date.now();

  if (!flagOn) {
    // Off: the loop is still inside its epilogue; nothing moves until the side call in
    // flight returns (turn end + 5 s for the suggestion, + 10 s for the sweep).
    await settle();
    expect(s.transport.of('main')).toHaveLength(1);
    const busyUntil = turnEndAt + (followUpAtMs > SIDE_MS ? 2 * SIDE_MS : SIDE_MS);
    await vi.advanceTimersByTimeAsync(busyUntil - Date.now());
  }
  await pumpUntil(() => s.transport.of('main').length === 2, 'turn 2 model request');
  const latencyMs = s.transport.of('main')[1].at - sentAt;
  await pumpUntil(() => turnEnds(s.events).length === 2, 'turn 2 turn_end');
  await finish(s);
  return { ...s, latencyMs, eventsBeforeFollowUp };
}

describe('POST_TURN_OFF_PATH_V1 — follow-up start latency (the measurement)', () => {
  it('a follow-up 1 s after turn_end, while the 5 s suggestion runs: off waits 4 s, on starts at once', async () => {
    const off = await exchange(false, 1_000, 't-lat-1-off');
    const on = await exchange(true, 1_000, 't-lat-1-on');
    expect(off.latencyMs).toBe(4_000);
    expect(on.latencyMs).toBe(0);
  }, 30_000);

  it('a follow-up 6 s after turn_end, while the 5 s sweep runs: off waits 4 s, on starts at once', async () => {
    const off = await exchange(false, 6_000, 't-lat-6-off');
    const on = await exchange(true, 6_000, 't-lat-6-on');
    expect(off.latencyMs).toBe(4_000);
    expect(on.latencyMs).toBe(0);
  }, 30_000);
});

describe('POST_TURN_OFF_PATH_V1 — what a preempted epilogue leaves behind', () => {
  it('follow-up during the suggestion: the stale chip is never emitted, the sweep is deferred and runs exactly once', async () => {
    const on = await exchange(true, 1_000, 't-pre-1');
    const [first, second] = on.transport.of('suggestion');
    expect(first.aborted).toBe(true);
    expect(second.returned).toBe(true);
    // Exactly ONE chip, turn 2's, after turn 2's turn_end: turn 1's prediction never shows.
    const chips = raws(on.events, CHIP);
    expect(chips).toHaveLength(1);
    expect(on.events.indexOf(chips[0])).toBeGreaterThan(on.events.indexOf(turnEnds(on.events)[1]));
    // Turn 1's sweep never started; the owed one ran once, after turn 2, covering both turns.
    expect(on.transport.of('sweep')).toHaveLength(1);
    expect(on.transport.of('sweep')[0].at).toBeGreaterThan(on.transport.of('main')[1].at);
    expect(lane(on.events, 'sweep').map((e) => e.laneStatus)).toEqual(['ok']);
    expect(raws(on.events, DEPOSIT)).toHaveLength(1);
    // The cut suggestion's row is 'cancelled'; its abort settled at once, so nothing slow was reported.
    expect(lane(on.events, 'suggestion').map((e) => e.laneStatus)).toEqual(['cancelled', 'ok']);
    expect(on.cuts).toEqual([]);
  }, 30_000);

  it('follow-up during the sweep: the sweep is cut short once, owed, and merged into turn 2 (one returned sweep)', async () => {
    const on = await exchange(true, 6_000, 't-pre-6');
    const sweeps = on.transport.of('sweep');
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0].aborted).toBe(true);
    expect(sweeps[1].returned).toBe(true);
    // The cut-short call meters as its own 'cancelled' row (zero tokens: the provider had reported
    // none yet), never as a failure; only the returned one carries the sweep's spend.
    const rows = lane(on.events, 'sweep');
    expect(rows.map((e) => e.laneStatus)).toEqual(['cancelled', 'ok']);
    expect(rows[0].usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(new Set(rows.map((e) => e.messageId)).size).toBe(2);
    expect(raws(on.events, DEPOSIT)).toHaveLength(1);
    // Turn 1's chip DID return before the follow-up, so it was shown, before the follow-up was sent.
    const chips = raws(on.events, CHIP);
    expect(chips).toHaveLength(2);
    expect(on.events.indexOf(chips[0])).toBeLessThan(on.eventsBeforeFollowUp);
  }, 30_000);

  it('a trivial follow-up during the sweep: the cut sweep is owed and still returns once, as the flag-off wait did', async () => {
    // "thanks" asks for no sweep of its own, so only the owed one can recover turn 1's capture.
    const off = await exchange(false, 6_000, 't-owed', 'thanks');
    const on = await exchange(true, 6_000, 't-owed', 'thanks');
    expect(off.transport.of('sweep').filter((c) => c.returned)).toHaveLength(1);
    expect(on.transport.of('sweep').filter((c) => c.returned)).toHaveLength(1);
    expect(lane(on.events, 'sweep').map((e) => e.laneStatus)).toEqual(['cancelled', 'ok']);
    expect(raws(on.events, DEPOSIT)).toEqual(raws(off.events, DEPOSIT));
    expect(on.latencyMs).toBe(0);
  }, 30_000);

  it('flag off keeps today: the stale chip IS emitted after the follow-up, and the staged gate drops turn 1 sweep', async () => {
    const off = await exchange(false, 1_000, 't-pre-off');
    expect(raws(off.events, CHIP)).toHaveLength(2);
    expect(off.events.indexOf(raws(off.events, CHIP)[0])).toBeGreaterThanOrEqual(off.eventsBeforeFollowUp);
    expect(off.transport.of('sweep')).toHaveLength(1);
  }, 30_000);
});

describe('POST_TURN_OFF_PATH_V1 — billing, ordering and the journal', () => {
  it('main-lane billing is identical on and off; the sweep lane bills the same one sweep; the cut suggestion bills zero', async () => {
    const off = await exchange(false, 1_000, 't-bill');
    const on = await exchange(true, 1_000, 't-bill');
    const billing = (s: { events: HarnessEvent[] }) =>
      turnEnds(s.events).map((e) => (e as { billing?: unknown }).billing);
    expect(billing(on)).toEqual(billing(off));
    expect(lane(on.events, 'sweep').map((e) => e.usage)).toEqual(lane(off.events, 'sweep').map((e) => e.usage));
    const cut = lane(on.events, 'suggestion')[0];
    expect(cut.laneStatus).toBe('cancelled');
    expect(cut.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(lane(on.events, 'suggestion')[1]).toMatchObject({ laneStatus: 'ok', usage: { inputTokens: 2_100, outputTokens: 9 } });
  }, 30_000);

  it('the visible end of the turn is not delayed, and side events only ever sit between turns', async () => {
    for (const [flagOn, at] of [[true, 1_000], [true, 6_000], [false, 1_000], [false, 6_000]] as const) {
      const s = await exchange(flagOn, at, `t-order-${flagOn}-${at}`);
      expect(sideEventsOnlyBetweenTurns(s.events)).toBe(true);
      // turn_end was already yielded when the first side call was requested, at the same instant.
      expect(s.turnEndsAtFirstSideCall()).toBeGreaterThanOrEqual(1);
      const firstSide = s.transport.calls.find((c) => c.role !== 'main')!;
      expect(firstSide.at).toBe(s.transport.of('main')[0].at);
      expect(s.events.findIndex((e) => e.kind === 'turn_end')).toBeLessThan(s.events.findIndex(isSide));
    }
  }, 60_000);

  it('the journal a resume replays is identical on and off (side calls write nothing to it)', async () => {
    for (const at of [1_000, 6_000]) {
      const off = await exchange(false, at, `t-journal-${at}`);
      const on = await exchange(true, at, `t-journal-${at}`);
      const offPayloads = await journalPayloads(off.journal);
      expect(offPayloads.length).toBeGreaterThan(0);
      expect(await journalPayloads(on.journal)).toEqual(offPayloads);
      expect((await on.journal.project()).messages.map((e) => e.payload)).toEqual(
        (await off.journal.project()).messages.map((e) => e.payload),
      );
    }
  }, 60_000);

  it('the suggestion takes the low reasoning floor only under the flag', async () => {
    const off = await exchange(false, 1_000, 't-effort-off');
    const on = await exchange(true, 1_000, 't-effort-on');
    expect(off.transport.of('suggestion').map((c) => c.reasoningEffort)).toEqual([undefined, undefined]);
    expect(on.transport.of('suggestion').map((c) => c.reasoningEffort)).toEqual(['low', 'low']);
    // The sweep's own floor is unchanged either way.
    expect([...off.transport.of('sweep'), ...on.transport.of('sweep')].every((c) => c.reasoningEffort === 'low')).toBe(true);
  }, 30_000);
});

describe('POST_TURN_OFF_PATH_V1 — edges', () => {
  it('a one-shot input (ends after its turn) yields the same events on and off: nobody waits, the work finishes', async () => {
    const run = async (flagOn: boolean) => {
      if (flagOn) process.env[FLAG] = 'true';
      else delete process.env[FLAG];
      vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
      const s = startSession('t-oneshot', { main: 0, suggestion: 0, sweep: 0 });
      s.queue.push('build me the quarterly report');
      s.queue.close();
      await pumpUntil(s.done, 'the one-shot run to end');
      return s.events;
    };
    const off = await run(false);
    const on = await run(true);
    expect(lane(off, 'sweep')).toHaveLength(1);
    expect(raws(off, CHIP)).toHaveLength(1);
    expect(on).toEqual(off);
  }, 30_000);

  it('a message already staged at turn end starts nothing; the sweep it would have skipped is owed, never lost', async () => {
    // Turn 2 is trivial, so it asks for no sweep of its own: only an OWED sweep can run.
    const run = async (flagOn: boolean, taskId: string) => {
      if (flagOn) process.env[FLAG] = 'true';
      else delete process.env[FLAG];
      const s = startSession(taskId, { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS });
      s.queue.push('build me the quarterly report');
      s.queue.push('thanks');
      await pumpUntil(() => turnEnds(s.events).length === 2 && s.transport.sleeping === 1, 'both turns, then the turn 2 suggestion waiting');
      // Turn 1 started nothing: its only side call is turn 2's suggestion.
      expect(s.transport.of('suggestion')).toHaveLength(1);
      expect(s.transport.of('sweep')).toHaveLength(0);
      await finish(s);
      return s;
    };
    // Off (today): the staged gate skipped turn 1's sweep and the trivial turn asks for none.
    expect((await run(false, 't-staged-off')).transport.of('sweep')).toHaveLength(0);
    // On: turn 1's sweep was owed and ran once, after turn 2.
    const on = await run(true, 't-staged-on');
    expect(on.transport.of('sweep')).toHaveLength(1);
    expect(lane(on.events, 'sweep').map((e) => e.laneStatus)).toEqual(['ok']);
  }, 30_000);

  it('a consumer that stops reading mid-idle (a superseded run) returns at once, without waiting for a message', async () => {
    process.env[FLAG] = 'true';
    const transport = new TimedTransport({ main: 0, suggestion: SIDE_MS, sweep: SIDE_MS });
    const queue = turnQueue();
    const cfg = {
      onAttached: () => {}, maxTurns: 4, transport, journal: makeJournal('t-return'),
      workingDir: join(tmpdir(), `post-turn-wd-${process.pid}-ret`),
      suggestNextPrompt: true, namiOffloopSweep: true, hasPendingInput: queue.pending,
    } as unknown as NativeConfig;
    const gen = new NativeHarness()
      .run(queue.iterable, { taskId: 't-return', sessionId: 's', cwd: '/tmp', model: 'fake-model', signal: new AbortController().signal, config: cfg })
      [Symbol.asyncIterator]();
    let sawChip = false;
    void (async () => {
      for (;;) {
        const r = await gen.next();
        if (r.done || (r.value.kind === 'raw' && (r.value as { event?: string }).event === CHIP)) {
          sawChip = !r.done;
          return;
        }
      }
    })();
    queue.push('build me the quarterly report');
    await pumpUntil(() => transport.sleeping === 1, 'the suggestion, waiting');
    await vi.advanceTimersByTimeAsync(SIDE_MS);
    await pumpUntil(() => sawChip, 'the chip, yielded while the next pull is pending');
    let returned = false;
    void gen.return!(undefined).then(() => (returned = true));
    await pumpUntil(() => returned, 'run().return() with a pull pending');
    queue.close();
    await settle();
  }, 30_000);

  it('sessions share no state: one session preempted by its follow-up leaves a parallel session idle work untouched', async () => {
    process.env[FLAG] = 'true';
    const a = startSession('t-par-a', { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS });
    const b = startSession('t-par-b', { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS });
    a.queue.push('build me the quarterly report');
    b.queue.push('draft the board memo');
    await pumpUntil(() => a.transport.sleeping === 1 && b.transport.sleeping === 1, 'both suggestions, waiting');
    await vi.advanceTimersByTimeAsync(1_000);
    a.queue.push('also add the EU numbers');
    await pumpUntil(() => a.transport.of('main').length === 2, 'session A turn 2');
    expect(a.transport.of('suggestion')[0].aborted).toBe(true);
    expect(b.transport.of('suggestion')[0].aborted).toBeUndefined();
    await pumpUntil(() => a.transport.sleeping === 1, 'session A turn 2 suggestion, waiting');
    await vi.advanceTimersByTimeAsync(SIDE_MS - 1_000);
    await pumpUntil(() => raws(b.events, CHIP).length === 1, 'session B chip');
    await pumpUntil(() => b.transport.of('sweep').length === 1, 'session B sweep');
    // A's turn 1 chip was cut; its turn 2 suggestion (sent at +1 s) is still running.
    expect(raws(a.events, CHIP)).toHaveLength(0);
    await finish(a, b);
    expect(raws(a.events, CHIP)).toHaveLength(1);
    expect(b.transport.of('sweep')[0].returned).toBe(true);
  }, 30_000);
});

describe('POST_TURN_OFF_PATH_V1 — pre-flip fixes', () => {
  it('a cut call the provider had already reported usage for carries that usage on its cancelled row', async () => {
    process.env[FLAG] = 'true';
    // The suggestion streams its reply and its `done` at once, then holds the connection open.
    const s = startSession('t-spent', { main: 0, suggestion: 0, sweep: SIDE_MS }, { transport: { tailAfterDone: { suggestion: SIDE_MS } } });
    s.queue.push('build me the quarterly report');
    await pumpUntil(() => turnEnds(s.events).length === 1 && s.transport.sleeping === 1, 'turn 1, then its suggestion held open');
    await vi.advanceTimersByTimeAsync(1_000);
    s.queue.push('also add the EU numbers');
    await pumpUntil(() => s.transport.of('main').length === 2, 'turn 2 model request');
    expect(s.transport.of('suggestion')[0].aborted).toBe(true);
    const [cut] = lane(s.events, 'suggestion');
    expect(cut).toMatchObject({ laneStatus: 'cancelled', usage: { inputTokens: 2_100, outputTokens: 9 } });
    await finish(s);
    // The prediction itself was stale: turn 1's chip never shows (turn 2's does, after its turn_end).
    const chips = raws(s.events, CHIP);
    expect(chips).toHaveLength(1);
    expect(s.events.indexOf(chips[0])).toBeGreaterThan(s.events.indexOf(turnEnds(s.events)[1]));
  }, 30_000);

  it('a slow settle after the cut is waited out before the message is handed over, and reported', async () => {
    process.env[FLAG] = 'true';
    const s = startSession('t-slow', { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS }, { transport: { abortSettleMs: { suggestion: 700 } } });
    s.queue.push('build me the quarterly report');
    await pumpUntil(() => turnEnds(s.events).length === 1 && s.transport.sleeping === 1, 'turn 1, then its suggestion waiting');
    await vi.advanceTimersByTimeAsync(1_000);
    s.queue.push('also add the EU numbers');
    const sentAt = Date.now();
    await settle();
    // Cut, but not settled: the follow-up is NOT handed over yet.
    expect(s.transport.of('main')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    await pumpUntil(() => s.transport.of('main').length === 2, 'turn 2 model request');
    expect(s.transport.of('main')[1].at - sentAt).toBe(700);
    expect(s.cuts).toEqual([{ lane: 'suggestion', settleMs: 700 }]);
    expect(lane(s.events, 'suggestion')[0].laneStatus).toBe('cancelled');
    await finish(s);
  }, 30_000);

  it('a silent push during idle never cuts; it is handed over first, and the real follow-up still cuts at once', async () => {
    process.env[FLAG] = 'true';
    const s = startSession('t-silent', { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS });
    s.queue.push('build me the quarterly report');
    await pumpUntil(() => turnEnds(s.events).length === 1 && s.transport.sleeping === 1, 'turn 1, then its suggestion waiting');
    await vi.advanceTimersByTimeAsync(1_000);
    s.queue.push('the chart is ready', { shouldQuery: false });
    await settle();
    expect(s.transport.of('suggestion')[0].aborted).toBeUndefined();
    expect(s.transport.of('main')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    s.queue.push('also add the EU numbers');
    const sentAt = Date.now();
    await pumpUntil(() => s.transport.of('main').length === 2, 'turn 2 model request');
    expect(s.transport.of('main')[1].at).toBe(sentAt);
    expect(s.transport.of('suggestion')[0].aborted).toBe(true);
    await finish(s);
    // The silent push reached turn 2, merged into it the way the loop stages it.
    const users = (await journalPayloads(s.journal)).filter((pl) => (pl as { type?: string }).type === 'user');
    const turn2 = JSON.stringify(users.at(-1));
    expect(turn2).toContain('the chart is ready');
    expect(turn2).toContain('also add the EU numbers');
  }, 30_000);

  it('the run signal aborting while a side call is in flight between turns: an error row (not cancelled), no chip, no sweep', async () => {
    process.env[FLAG] = 'true';
    const run = new AbortController();
    const s = startSession('t-run-abort', { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS }, { signal: run.signal });
    s.queue.push('build me the quarterly report');
    await pumpUntil(() => turnEnds(s.events).length === 1 && s.transport.sleeping === 1, 'turn 1, then its suggestion waiting');
    run.abort();
    await pumpUntil(() => lane(s.events, 'suggestion').length === 1, 'the aborted suggestion row');
    await settle();
    expect(s.transport.of('suggestion')[0].aborted).toBe(true);
    expect(lane(s.events, 'suggestion')[0].laneStatus).toBe('error');
    expect(raws(s.events, CHIP)).toHaveLength(0);
    // The sweep sees an aborted run before any request: skipped, nothing sent, nothing metered.
    expect(s.transport.of('sweep')).toHaveLength(0);
    expect(lane(s.events, 'sweep')).toHaveLength(0);
    expect(s.cuts).toEqual([]);
    s.queue.close();
    await pumpUntil(s.done, 'the run to end after the input closed');
  }, 30_000);

  it('each side call removes its run-signal listener: the count does not grow turn over turn', async () => {
    process.env[FLAG] = 'true';
    const run = new AbortController();
    const listeners = () => getEventListeners(run.signal, 'abort').length;
    const s = startSession('t-listeners', { main: 0, suggestion: 0, sweep: 0 }, { signal: run.signal });
    s.queue.push('build me the quarterly report');
    await pumpUntil(() => lane(s.events, 'sweep').length === 1, 'turn 1 idle work done');
    const afterOne = listeners();
    s.queue.push('now the board memo for march');
    await pumpUntil(() => lane(s.events, 'sweep').length === 2, 'turn 2 idle work done');
    s.queue.push('and the hiring plan for europe');
    await pumpUntil(() => lane(s.events, 'sweep').length === 3, 'turn 3 idle work done');
    expect(listeners()).toBe(afterOne);
    await finish(s);
  }, 30_000);

  it('the input throwing mid-idle is no follow-up: the work finishes, then the throw surfaces, exactly as with the flag off', async () => {
    const run = async (flagOn: boolean) => {
      if (flagOn) process.env[FLAG] = 'true';
      else delete process.env[FLAG];
      vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
      // The lane closing under a pull: the next pull rejects at once.
      const input = (async function* (): AsyncGenerator<UserTurn> {
        yield { text: 'build me the quarterly report' };
        throw new Error('stream_closed');
      })();
      const s = startSession('t-throw', { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS }, { input });
      await pumpUntil(() => turnEnds(s.events).length === 1, 'turn 1 turn_end');
      await drain(s);
      return s;
    };
    const off = await run(false);
    const on = await run(true);
    expect((off.error() as Error).message).toBe('stream_closed');
    expect((on.error() as Error).message).toBe('stream_closed');
    expect(raws(on.events, CHIP)).toHaveLength(1);
    expect(lane(on.events, 'sweep').map((e) => e.laneStatus)).toEqual(['ok']);
    expect(on.events).toEqual(off.events);
  }, 30_000);
});

describe('side-call rows carry their wall time (MODEL_CALL_EVENTS_V1)', () => {
  it('a returned side call carries its whole call; one cut by the next message carries the time until the cut', async () => {
    const off = await exchange(false, 1_000, 't-wall-off');
    expect([...lane(off.events, 'suggestion'), ...lane(off.events, 'sweep')].map((e) => e.latencyMs)).toEqual([SIDE_MS, SIDE_MS, SIDE_MS]);
    const on = await exchange(true, 1_000, 't-wall-on');
    const [cut, returned] = lane(on.events, 'suggestion');
    expect(cut).toMatchObject({ laneStatus: 'cancelled', latencyMs: 1_000 });
    expect(returned).toMatchObject({ laneStatus: 'ok', latencyMs: SIDE_MS });
    expect(lane(on.events, 'sweep').map((e) => e.latencyMs)).toEqual([SIDE_MS]);
  }, 30_000);
});

describe('POST_TURN_OFF_PATH_V1 — the box stays awake for the idle lane\'s side calls (unflagged billing fix)', () => {
  it('the hold opens before the chip and the sweep go out and closes only once the sweep has returned', async () => {
    process.env[FLAG] = 'true';
    const seen: Array<{ at: 'hold' | 'release'; sideCalls: number; sweepReturned: boolean }> = [];
    let open = 0;
    const s: Session = startSession('t-hold', { main: 0, suggestion: SIDE_MS, sweep: SIDE_MS }, {
      hold: () => {
        open += 1;
        seen.push({ at: 'hold', sideCalls: s.transport.calls.length - s.transport.of('main').length, sweepReturned: false });
        return () => {
          open -= 1;
          seen.push({ at: 'release', sideCalls: s.transport.calls.length - s.transport.of('main').length, sweepReturned: s.transport.of('sweep')[0]?.returned === true });
        };
      },
    });
    s.queue.push('build me the quarterly report');
    await pumpUntil(() => turnEnds(s.events).length === 1, 'turn 1 turn_end');
    await pumpUntil(() => s.transport.of('suggestion').length === 1 && s.transport.sleeping === 1, 'the suggestion, waiting');
    // Mutation: take the hold only for a turn-end compaction (as before) → no hold, the box stands by mid-call.
    expect(open).toBe(1);
    await vi.advanceTimersByTimeAsync(SIDE_MS);
    await pumpUntil(() => s.transport.of('sweep').length === 1 && s.transport.sleeping === 1, 'the sweep, waiting');
    expect(open).toBe(1); // still held while the sweep is in flight
    await vi.advanceTimersByTimeAsync(SIDE_MS);
    await pumpUntil(() => open === 0, 'the hold to close');
    expect(seen).toEqual([
      { at: 'hold', sideCalls: 0, sweepReturned: false },
      { at: 'release', sideCalls: 2, sweepReturned: true },
    ]);
    await finish(s);
  }, 30_000);
});


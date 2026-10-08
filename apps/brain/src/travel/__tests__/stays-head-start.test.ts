import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TripEvent } from '../../door/methods.js';
import { FakeSwitches } from '../../tasks/testing/lane-brain.js';
import type { EngineAnswer } from '../book/engine.js';
import {
  createStaysHeadStart, HEAD_START_MAX_NIGHTS, HEAD_START_ON_MESSAGE_MS, HEAD_START_SETTLE_MS, HEAD_STARTS_PER_DAY, STAYS_HEAD_START_STEP,
  type HeadStartAsk, type StaysHeadStartDeps,
} from '../warm.js';

const ANSWER: EngineAnswer = { as: 'options', options: [], page: 'https://www.ixigo.com/hotels/search/result?locationId=32', checkedAt: '2026-10-08T10:00:00Z', ms: 9_000 };
const TTL_MS = 30 * 60_000;
const GOA = { destination: 'Goa', start: '2026-11-06', end: '2026-11-09' };

/**
 * A head start over a scripted Go: the trip (Goa, 6 to 9 Nov), its today, and Go's searches. `share` records each call
 * and, unless a search is kept (joined), runs the given run; `run` is the stays page, 9 s on the clock.
 */
function rig(o: { mode?: string; trip?: { destination: string | null; start: string | null; end: string | null }; today?: string; joined?: boolean; fails?: boolean; gaveUp?: boolean; noComputer?: boolean } = {}) {
  const switches = new FakeSwitches();
  void switches.set('TRAVEL_MODE', o.mode ?? 'ixigo_web');
  let nowMs = Date.parse('2026-10-08T10:00:00Z');
  const shares: Array<{ tripId: string; ask: HeadStartAsk }> = [];
  const loads: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps: StaysHeadStartDeps = {
    switches,
    now: () => new Date(nowMs),
    log,
    trip: async () => o.trip ?? GOA,
    today: async () => o.today ?? '2026-10-08',
    share: async (tripId, ask, run) => {
      shares.push({ tripId, ask });
      if (o.joined) return { answer: Promise.resolve(ANSWER), joined: true };
      return { answer: run(), joined: false };
    },
    run: async (tripId) => {
      loads.push(tripId);
      nowMs += 9_000;
      if (o.fails) throw new Error('ixigo took too long to answer. Try again in a moment.');
      return ANSWER;
    },
    ttlMs: TTL_MS,
    warmGaveUp: () => o.gaveUp ?? false,
    computerSetUp: () => !o.noComputer,
  };
  return { hs: createStaysHeadStart(deps), shares, loads, log, advance: (ms: number) => (nowMs += ms) };
}

const updated = (changed: string[], tripId = 't_goa'): TripEvent =>
  ({ event_id: `e_${changed.join('_')}`, trip_id: tripId, seq: 2, type: 'trip.updated', data: { by: { kind: 'person', person_id: 'p_rahul' }, changed } }) as never;
const said = (kind: 'person' | 'go', tripId = 't_goa'): TripEvent =>
  ({ event_id: `e_${kind}`, trip_id: tripId, seq: 3, type: 'message.created', data: { message: { author: kind === 'person' ? { kind, person_id: 'p_rahul' } : { kind } } } }) as never;
/** Long enough for a head start that would run to have asked Go's searches. */
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

afterEach(() => {
  vi.useRealTimers();
});

describe(`createStaysHeadStart (${STAYS_HEAD_START_STEP}): the trip's likely first stays search, before anyone asks`, () => {
  it("at setup, shares hotels.search for the trip's destination and dates, loads it once, and keeps it under the key its run made known", async () => {
    const r = rig();
    await expect(r.hs.atSetup('t_goa')).resolves.toBeUndefined();
    // Setup never waits on ixigo: the step is back before the page loads.
    expect(r.loads).toEqual([]);
    await vi.waitFor(() => expect(r.shares).toHaveLength(2));
    expect(r.loads).toEqual(['t_goa']);
    // No head count and no conditions: the trip's own head count, as the engine fills it for the ask too.
    expect(r.shares.map((s) => s.ask)).toEqual([{ place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' }]);
    expect(r.hs.stat()).toEqual({ recipe: STAYS_HEAD_START_STEP, speed: 'page', runs: 1, failed: 0, p50_ms: 9_000, p90_ms: 9_000 });
    expect(r.log.info).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_goa', why: 'setup' }), expect.stringContaining('head start is kept'));
  });

  it('never in the other modes or with no trip computer, without a destination or both dates, for dates gone by, a stay too long, or after the warm gave up', async () => {
    const cases: Array<[string, Parameters<typeof rig>[0]]> = [
      ['fake mode', { mode: 'fake' }],
      ['ixigo mode', { mode: 'ixigo' }],
      ['no destination', { trip: { ...GOA, destination: null } }],
      ['no dates', { trip: { ...GOA, start: null, end: null } }],
      ['no check-out', { trip: { ...GOA, end: null } }],
      ['check-in gone by', { today: '2026-11-07' }],
      ['over the longest stay', { trip: { ...GOA, end: '2026-12-07' } }],
      ['check-out before check-in', { trip: { ...GOA, end: '2026-11-05' } }],
      ['the warm gave up', { gaveUp: true }],
      ['no trip computer here', { noComputer: true }],
    ];
    expect(Math.round((Date.parse('2026-12-07') - Date.parse(GOA.start)) / 86_400_000)).toBeGreaterThan(HEAD_START_MAX_NIGHTS);
    for (const [name, o] of cases) {
      const r = rig(o);
      await r.hs.atSetup('t_goa');
      await quiet();
      expect(r.shares, name).toEqual([]);
      expect(r.hs.stat(), name).toBeNull();
    }
  });

  it('loads nothing when a search for the same page is kept or running: the ask, or an early start, got there first', async () => {
    const r = rig({ joined: true });
    await r.hs.atSetup('t_goa');
    await vi.waitFor(() => expect(r.shares).toHaveLength(1));
    await quiet();
    expect(r.loads).toEqual([]);
    expect(r.hs.stat()).toBeNull();
  });

  it(`loads at most ${HEAD_STARTS_PER_DAY} times a trip a day (UTC), then waits for the next day`, async () => {
    const r = rig();
    for (let i = 1; i <= HEAD_STARTS_PER_DAY + 1; i += 1) {
      await r.hs.atSetup('t_goa');
      await quiet();
    }
    expect(r.loads).toHaveLength(HEAD_STARTS_PER_DAY);
    expect(r.log.info).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_goa' }), expect.stringContaining('used up for today'));
    // Another trip's day is its own.
    await r.hs.atSetup('t_other');
    await vi.waitFor(() => expect(r.loads).toHaveLength(HEAD_STARTS_PER_DAY + 1));
    r.advance(24 * 60 * 60_000);
    await r.hs.atSetup('t_goa');
    await vi.waitFor(() => expect(r.loads).toHaveLength(HEAD_STARTS_PER_DAY + 2));
  });

  it('a failed head start is counted and logged, never thrown: the ask runs its own search', async () => {
    const r = rig({ fails: true });
    await expect(r.hs.atSetup('t_goa')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(r.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_goa', why: 'setup' }), expect.stringContaining('head start failed')));
    expect(r.hs.stat()).toEqual({ recipe: STAYS_HEAD_START_STEP, speed: 'page', runs: 1, failed: 1, p50_ms: null, p90_ms: null });
    // Only the run itself was asked: nothing is kept under another key.
    expect(r.shares).toHaveLength(1);
  });

  it(`runs again when the trip's dates or destination change, once the edit has settled (${HEAD_START_SETTLE_MS / 1000} s), and not for other changes`, async () => {
    vi.useFakeTimers();
    const r = rig();
    r.hs.onEvent(updated(['title', 'vibe']));
    await vi.advanceTimersByTimeAsync(HEAD_START_SETTLE_MS);
    expect(r.shares).toEqual([]);
    r.hs.onEvent(updated(['dates']));
    await vi.advanceTimersByTimeAsync(10_000);
    r.hs.onEvent(updated(['destination', 'title']));
    await vi.advanceTimersByTimeAsync(HEAD_START_SETTLE_MS - 1);
    expect(r.shares).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(r.loads).toEqual(['t_goa']));
    expect(r.log.info).toHaveBeenCalledWith(expect.objectContaining({ why: 'changed' }), expect.any(String));
  });

  it("runs again on a person's first line once the last head start ran out of its time, and not on Go's own lines", async () => {
    const r = rig();
    await r.hs.atSetup('t_goa');
    await vi.waitFor(() => expect(r.loads).toHaveLength(1));
    // Still kept: a line loads nothing.
    r.hs.onEvent(said('person'));
    await quiet();
    expect(r.loads).toHaveLength(1);
    r.advance(TTL_MS);
    r.hs.onEvent(said('go'));
    await quiet();
    expect(r.loads).toHaveLength(1);
    r.hs.onEvent(said('person'));
    await vi.waitFor(() => expect(r.loads).toHaveLength(2));
    expect(r.log.info).toHaveBeenCalledWith(expect.objectContaining({ why: 'message' }), expect.any(String));
  });

  it(`a line runs it at most once in ${HEAD_START_ON_MESSAGE_MS / 60_000} minutes, even while each one fails`, async () => {
    const r = rig({ fails: true });
    r.hs.onEvent(said('person'));
    await vi.waitFor(() => expect(r.loads).toHaveLength(1));
    r.advance(TTL_MS);
    r.hs.onEvent(said('person'));
    await quiet();
    expect(r.loads).toHaveLength(1);
    r.advance(HEAD_START_ON_MESSAGE_MS);
    r.hs.onEvent(said('person'));
    await vi.waitFor(() => expect(r.loads).toHaveLength(2));
  });

  it('stop() drops a head start still waiting for its edit to settle', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.hs.onEvent(updated(['dates']));
    r.hs.stop();
    await vi.advanceTimersByTimeAsync(HEAD_START_SETTLE_MS * 2);
    expect(r.shares).toEqual([]);
  });
});

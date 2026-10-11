import { describe, expect, it, vi } from 'vitest';
import { makeTurnCtx } from '../../composer/tools.js';
import type { DeskItem } from '../../desk/desk.js';
import { msg } from '../../__tests__/fixtures/goa.js';
import { goaPack } from '../../tasks/testing/goa.js';
import type { TripPack } from '../../trips/pack.js';
import { loadBook } from '../book/book.js';
import type { Engine } from '../book/engine.js';
import { roomPastHeadStart, showHeadStartStays } from '../head-start-wake.js';
import type { Images } from '../images.js';
import { createIxigoWebBackend } from '../recipes/backend.js';
import type { RecipeOption } from '../recipes/recipe.js';
import type { ResultsStore } from '../results.js';
import { searchWakeAnswer } from '../search-wake.js';
import type { Travel } from '../travel.js';
import { FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { createStaysHeadStart, HEAD_START_SETTLE_MS, type HeadStartAsk } from '../warm.js';

const { book } = loadBook();
const now = () => new Date('2026-10-08T12:00:00Z');
/** The trip's stays head start for Goa, 6 to 9 Nov: its place and dates, no conditions (warm.ts). */
const HEAD: HeadStartAsk = { place: 'Goa', check_in: '2026-11-06', check_out: '2026-11-09' };
const stay = (n: number): RecipeOption => ({
  kind: 'stay', title: `Stay ${n}`, priceMinor: 500_000 + n, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {},
  sourceUrl: `https://www.ixigo.com/hotels/${n}/details`,
});

/**
 * Go's searches over a scripted hotels.search (every run counted: a run is a page load), with the head start run
 * through them as warm.ts runs it, and the travel layer's search on top.
 */
function rig() {
  const loads: string[][] = [];
  const answer: Engine['answer'] = async (_id, _given, o) => {
    loads.push(o.conditions ?? []);
    return { as: 'options', options: [stay(1), stay(2), stay(3), stay(4)], page: 'https://www.ixigo.com/hotels/search/result', checkedAt: '2026-10-08T11:59:00.000Z', ms: 9_000 };
  };
  const b = createIxigoWebBackend({ book, engine: { answer }, now });
  const headStart = async (): Promise<void> => {
    const shared = await b.shareStep('hotels.search', { ...HEAD }, { tripId: 't_goa', conditions: [], background: true }, () => answer('hotels.search', { ...HEAD }, { tripId: 't_goa', conditions: [], background: true }));
    await shared?.answer;
  };
  const travel = { search: (...a: Parameters<Travel['search']>) => b.search(...a) } as unknown as Travel;
  return { loads, headStart, travel, b, answer };
}

/** A results store that keeps what it saves, and the cards put up from it. */
function store() {
  const sets = new Map<string, Record<string, unknown>>();
  let n = 0;
  return {
    save: async (s: Record<string, unknown>) => {
      n += 1;
      const set = { ...s, resultsId: `r_head${n}` };
      sets.set(set.resultsId, set);
      return set;
    },
    get: async (_t: string, id: string) => sets.get(id) ?? null,
    saveCard: async () => undefined, shownFrom: async () => [],
    card: async () => null,
  } as unknown as ResultsStore;
}
const images = { rehostUrl: async (u: string) => u } as unknown as Images;

/** The room after the group agreed 6 to 9 Nov: Go's hello, then the three lines; `goLast` adds Go's reply after them. */
function room(goLast = false): TripPack {
  const lines = [
    msg(1, null, "Hi all, I'm Go 👋 Tell me the dates and I'll start with a villa."),
    msg(2, 'p_priya', 'I can do 6 to 9 Nov'),
    msg(3, 'p_rahul', 'works for me'),
    msg(4, 'p_arjun', 'locking 6 to 9 Nov then'),
    ...(goLast ? [msg(5, null, 'Locked: 6 to 9 Nov.')] : []),
  ];
  return { ...goaPack(), messages: lines };
}

function show(pack: TripPack, travel: Travel, results: ResultsStore) {
  const puts: DeskItem[] = [];
  const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } };
  const log = { info: vi.fn(), warn: vi.fn() };
  const run = showHeadStartStays({ travel: () => travel, packs: { get: async () => pack }, desk, results, now, log });
  return { puts, log, run };
}

describe('dates agreed on a trip with a place: the head start\'s stays go up (lead, 8 Oct)', () => {
  it('puts them up as one card with its line, no model call, joining the kept search: one page load in all', async () => {
    const r = rig();
    await r.headStart();
    expect(r.loads).toEqual([[]]);
    const pack = room();
    const results = store();
    const s = show(pack, r.travel, results);
    s.run('t_goa', HEAD, now());
    await vi.waitFor(() => expect(s.puts).toHaveLength(1));
    // The travel layer's search joined the head start's kept one: nothing loaded again.
    expect(r.loads).toEqual([[]]);
    const item = s.puts[0]!;
    expect(item).toMatchObject({ tripId: 't_goa', kind: 'search', ref: 'stays', payload: { source: 'travel_search', error: null } });
    expect((item.payload as { count: number }).count).toBeGreaterThan(0);
    // The 'search' wake puts the card up itself: one card and its one line.
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_head', link: {} as never, pack, wake: [item], signal: new AbortController().signal });
    expect(await searchWakeAnswer({ results, images })({ tripId: 't_goa', wake: [item], pack, ctx })).toBe(true);
    expect(ctx.cards).toHaveLength(1);
    expect(ctx.cards[0]).toMatchObject({ kind: 'options' });
    expect(ctx.lines).toHaveLength(1);
    expect(ctx.lines[0]).toMatch(/6 to 9 Nov/);
    // The composer's own search for the same stays later joins it too.
    await r.travel.search('stays', { to: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' }, { tripId: 't_goa', turnId: 'turn_later' });
    expect(r.loads).toEqual([[]]);
  });

  it('puts nothing up when Go set the dates in reply to an ask: Go has the last word, never two in a row', async () => {
    const r = rig();
    await r.headStart();
    const search = vi.spyOn(r.travel, 'search');
    const s = show(room(true), r.travel, store());
    s.run('t_goa', HEAD, now());
    await vi.waitFor(() => expect(s.log.info).toHaveBeenCalledWith({ tripId: 't_goa' }, expect.stringContaining('wait for an ask')));
    expect(search).not.toHaveBeenCalled();
    expect(s.puts).toEqual([]);
  });

  it('the room is past the head start when Go has the last word, or Go put options up since the change', () => {
    const since = Date.parse('2026-10-08T11:59:00Z');
    const line = (seq: number, go: boolean, card: string | null, at: string) =>
      ({ message_id: `m_${seq}`, seq, author: go ? { kind: 'go' } : { kind: 'person', person_id: 'p_priya' }, card: card ? { kind: card } : null, deleted: false, sent_at: at }) as never;
    const pack = (...messages: never[]): TripPack => ({ ...goaPack(), messages });
    expect(roomPastHeadStart(pack(line(1, false, null, '2026-10-08T11:59:30Z')), since)).toBe(false);
    expect(roomPastHeadStart(pack(line(1, false, null, '2026-10-08T11:59:30Z'), line(2, true, null, '2026-10-08T11:59:40Z')), since)).toBe(true);
    // Go's stays card since the change, then someone spoke: the stays are up already.
    expect(roomPastHeadStart(pack(line(1, true, 'options', '2026-10-08T11:59:40Z'), line(2, false, null, '2026-10-08T11:59:50Z')), since)).toBe(true);
    // A card from before the change, or a vote card since, is not stays shown for these dates.
    expect(roomPastHeadStart(pack(line(1, true, 'options', '2026-10-08T11:58:00Z'), line(2, false, null, '2026-10-08T11:59:50Z')), since)).toBe(false);
    expect(roomPastHeadStart(pack(line(1, true, 'vote', '2026-10-08T11:59:40Z'), line(2, false, null, '2026-10-08T11:59:50Z')), since)).toBe(false);
    // The order is the room's (seq), not the list's.
    expect(roomPastHeadStart(pack(line(2, false, null, '2026-10-08T11:59:50Z'), line(1, true, null, '2026-10-08T11:59:40Z')), since)).toBe(false);
  });
});

describe('one ixigo load per agreement: the turn\'s own stays search, then the head start', () => {
  it("the turn's pool search for the agreed dates is the one load: the head start after the dates change loads nothing and wakes nothing", async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const kept = vi.fn();
      const log = { info: vi.fn(), warn: vi.fn() };
      const switches = new FakeSwitches();
      void switches.set('TRAVEL_MODE', 'ixigo_web');
      // The head start as register.ts wires it, over the same searches.
      const hs = createStaysHeadStart({
        switches, now, log,
        trip: async () => ({ destination: 'Goa', start: '2026-11-06', end: '2026-11-09' }),
        today: async () => '2026-10-08',
        share: (tripId, ask, run) => r.b.shareStep('hotels.search', { ...ask }, { tripId, conditions: [], background: true }, run),
        run: (tripId, ask) => r.answer('hotels.search', { ...ask }, { tripId, conditions: [], background: true }),
        ttlMs: 30 * 60_000,
        warmGaveUp: () => false,
        computerSetUp: () => true,
        staysKept: (tripId, ask) => r.b.pageKept('hotels.search', { ...ask }, { tripId }),
        onChangedKept: kept,
      });
      // "locking 6 to 9 Nov then": the turn shows pool stays for the dates (staging, 8 Oct: the hello promises a pool).
      await r.travel.search('stays', { to: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] }, { tripId: 't_goa', turnId: 'turn_lock' });
      expect(r.loads).toEqual([['pool']]);
      // The notes pass saved the dates: trip.updated, and the head start once the edit settles.
      hs.onEvent({ event_id: 'e_dates', trip_id: 't_goa', seq: 9, type: 'trip.updated', data: { by: { kind: 'go' }, changed: ['dates'] } } as never);
      await vi.advanceTimersByTimeAsync(HEAD_START_SETTLE_MS);
      await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_goa', why: 'changed' }), expect.stringContaining('kept already')));
      expect(r.loads).toEqual([['pool']]);
      expect(kept).not.toHaveBeenCalled();
      // With nothing kept for those dates (no turn searched), the head start is the one load, and it hands its stays on.
      const other = rig();
      const hs2 = createStaysHeadStart({
        switches, now, log,
        trip: async () => ({ destination: 'Goa', start: '2026-11-13', end: '2026-11-16' }),
        today: async () => '2026-10-08',
        share: (tripId, ask, run) => other.b.shareStep('hotels.search', { ...ask }, { tripId, conditions: [], background: true }, run),
        run: (tripId, ask) => other.answer('hotels.search', { ...ask }, { tripId, conditions: [], background: true }),
        ttlMs: 30 * 60_000,
        warmGaveUp: () => false,
        computerSetUp: () => true,
        staysKept: (tripId, ask) => other.b.pageKept('hotels.search', { ...ask }, { tripId }),
        onChangedKept: kept,
      });
      hs2.onEvent({ event_id: 'e_dates2', trip_id: 't_goa', seq: 9, type: 'trip.updated', data: { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['dates'] } } as never);
      await vi.advanceTimersByTimeAsync(HEAD_START_SETTLE_MS);
      await vi.waitFor(() => expect(kept).toHaveBeenCalledTimes(1));
      expect(other.loads).toEqual([[]]);
      hs.stop();
      hs2.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goaPack } from '../../tasks/testing/goa.js';
import type { TurnCtx } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import type { DeskItem } from '../../desk/desk.js';
import { msg } from '../../__tests__/fixtures/goa.js';
import { bookFlightTool, bookingNow } from '../book-flight.js';
import type { BookingAsk } from '../booking/flight-booking.js';
import { recordPick } from '../picks.js';
import type { StoredOffer } from '../travel.js';

// Prod, 11 Oct, BOOKING on since 08:13Z: "@Go book flights from BLR-DPS" got "I can't book flights. Each person books
// their own ticket on ixigo", and "Book my flights to Manali" got "Want me to?".
let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

const T = 't_book_words';
const offer = (optionId: string, over: Partial<StoredOffer> = {}): StoredOffer => ({
  optionId, tripId: T, cardId: 'c_each_rahul', resultsId: 'r_1', n: 1, offerId: null, kind: 'flight', title: 'IndiGo 6E2150', priceMinor: 600_000,
  totalMinor: null, currency: 'INR', priceNote: 'per person', checkedAt: '2026-10-11T08:00:00.000Z',
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=KUU&date=13112026&adults=1', ...over,
});

function deps(on: boolean) {
  const started: BookingAsk[] = [];
  const offers = new Map<string, StoredOffer>([['opt_6e', offer('opt_6e')], ['opt_web', offer('opt_web', { sourceUrl: null })]]);
  const d = {
    booking: { onFor: async () => on, start: async (ask: BookingAsk) => { started.push(ask); } },
    pool: db.pool,
    results: { offer: async (id: string) => offers.get(id) ?? null },
    nameOf: async (_t: string, id: string) => (id === 'p_rahul' ? 'Rahul' : 'Priya'),
  };
  return { d, started };
}
const ask = msg(40, 'p_rahul', '@Go book my flights to Manali');
const wake: DeskItem[] = [{ id: 'w40', tripId: T, kind: 'message', ref: ask.message_id, dueAt: new Date(), payload: { messageId: ask.message_id, namesGo: true } }];
const ctx = { tripId: T, turnId: 'turn_book_1', wake, pack: { ...goaPack(), messages: [ask] } } as unknown as TurnCtx;

describe('Go books flights where BOOKING is on', () => {
  it('says nothing in right now with BOOKING off: the rules stand as they were', async () => {
    expect(await bookingNow(deps(false).d).render(T, wake)).toBeNull();
  });

  it("tells the model it books a person's own flight, how, and never to send anyone to book it themselves", async () => {
    await recordPick(db.pool, { tripId: T, personId: 'p_rahul', kind: 'flight', way: 'DEL-KUU', optionId: 'opt_6e', title: 'IndiGo 6E2150', journey: null, pickedAt: new Date('2026-10-11T08:20:00Z') });
    const now = (await bookingNow(deps(true).d).render(T, wake))!;
    expect(now).toContain("You book a person's own flight on this trip");
    expect(now).toContain("never say you can't book flights, and never tell anyone to book on ixigo themselves");
    expect(now).toContain('call book_flight for them now');
    expect(now).toContain('search their flights at once, never "want me to?"');
    expect(now).toContain('is searched all the same: answer the ask, mention the trip once at most, and never refuse it');
    expect(now).toContain('(p_rahul) picked <data>IndiGo 6E2150</data>');
  });

  it("book_flight starts the booking of the asker's own pick, the same booking their tap starts", async () => {
    const { d, started } = deps(true);
    const out = (await bookFlightTool(d).run({}, ctx)) as Record<string, unknown>;
    expect(out).toMatchObject({ booking: 'IndiGo 6E2150', note: expect.stringContaining('nothing about booking it themselves') });
    expect(started).toEqual([expect.objectContaining({ tripId: T, personId: 'p_rahul', name: 'Rahul', choice: 'basic', offer: expect.objectContaining({ optionId: 'opt_6e' }) })]);
    // A rerun of the same turn is the same booking.
    await bookFlightTool(d).run({}, ctx);
    expect(started[1]!.tapId).toBe(started[0]!.tapId);
  });

  it('says a booking of theirs is already under way when one is, and starts nothing more', async () => {
    const { d } = deps(true);
    const out = (await bookFlightTool({ ...d, booking: { ...d.booking, start: async () => 'running' as const } }).run({}, ctx)) as Record<string, unknown>;
    expect(out).toEqual({ booking: 'IndiGo 6E2150', note: "A flight booking of Rahul's is already under way on the trip's computer; their own live card shows it. Say so in one short line." });
  });

  it('with no pick it says to search their flights now, and with BOOKING off it books nothing', async () => {
    const { d, started } = deps(true);
    expect(await bookFlightTool(d).run({ person_id: 'p_priya' }, ctx)).toMatchObject({ error: 'no_pick', note: expect.stringContaining('Search their flights now') });
    const off = deps(false);
    expect(await bookFlightTool(off.d).run({}, ctx)).toMatchObject({ error: 'not_here' });
    expect([...started, ...off.started]).toEqual([]);
  });
});

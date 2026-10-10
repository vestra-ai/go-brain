import { describe, expect, it } from 'vitest';
import { msg } from '../../__tests__/fixtures/goa.js';
import type { DeskItem } from '../../desk/desk.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { answerLine, answerTitle, directPicks, linkLine, plainAsk, plainEnglish } from '../answer.js';
import { toResultOption } from '../results.js';
import type { TravelOption, TravelQuery } from '../travel.js';

// The Goa trip: 6 to 9 Nov, North Goa; today is Wednesday 7 Oct.
const TODAY = '2026-10-07';
const asked = (text: string, o: { namesGo?: boolean } = {}) => {
  const line = msg(90, 'p_rahul', text);
  const pack = { ...goaPack(), messages: [...goaPack().messages, line] };
  const wake: DeskItem[] = [{ id: 'msg:t_goa:m_90', tripId: 't_goa', kind: 'message', ref: line.message_id, dueAt: new Date(), payload: { messageId: line.message_id, seq: 90, namesGo: o.namesGo ?? true } }];
  return { pack, wake };
};
const plain = (kind: Parameters<typeof plainAsk>[0], q: TravelQuery, text: string, o: { roundTools?: string[]; namesGo?: boolean; wake?: DeskItem[] } = {}) => {
  const a = asked(text, o);
  return plainAsk(kind, q, { wake: o.wake ?? a.wake, pack: a.pack, today: TODAY, ...(o.roundTools ? { roundTools: o.roundTools } : {}) });
};

const FLIGHTS: TravelQuery = { from: 'delhi', to: 'goa', date: '2026-11-06', departAfter: '19:00' };
const VILLAS: TravelQuery = { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] };

describe('a plain search ask, which the search answers itself', () => {
  it('is one message to Go, plainly English, read as this very search, asking nothing more', () => {
    expect(plain('flights', FLIGHTS, '@Go flights Delhi to Goa Friday after 7 pm')).toEqual({ ok: true });
    expect(plain('stays', VILLAS, '@Go stays with a pool in North Goa')).toEqual({ ok: true });
    // The model's own call, its one tool this round: places as it wrote them, and a condition more than the read took.
    expect(plain('flights', { ...FLIGHTS, from: 'Delhi', to: 'Goa', maxPriceMinor: 600_000 }, '@Go flights Delhi to Goa Friday after 7 pm', { roundTools: ['search_flights'] })).toEqual({ ok: true });
  });

  // Each case where the model round must still run: a misread plain ask must never swallow a real question.
  it('1. not when the ask questions or judges the options', () => {
    expect(plain('stays', VILLAS, '@Go villas with a pool in North Goa, which is closest to the beach?')).toMatchObject({ ok: false, why: 'asks more ("which")' });
    expect(plain('flights', FLIGHTS, '@Go flights Delhi to Goa Friday after 7 pm, best ones please')).toMatchObject({ ok: false });
  });

  it('2. not when the message asks for something else too', () => {
    expect(plain('flights', FLIGHTS, "@Go flights Delhi to Goa Friday after 7 pm, also what's the weather like")).toMatchObject({ ok: false });
  });

  it("3. not when it holds a condition the read can't take", () => {
    expect(plain('stays', VILLAS, '@Go villas with a pool in North Goa under 8k a head')).toMatchObject({ ok: false, why: 'asks more ("head")' });
    expect(plain('stays', VILLAS, '@Go villas with a pool in North Goa near the beach')).toMatchObject({ ok: false });
  });

  it('4. not when the round asked for more than this one search', () => {
    expect(plain('flights', FLIGHTS, '@Go flights Delhi to Goa Friday after 7 pm', { roundTools: ['search_flights', 'search_flights'] })).toMatchObject({ ok: false, why: 'more than one tool' });
    expect(plain('flights', FLIGHTS, '@Go flights Delhi to Goa Friday after 7 pm', { roundTools: ['search_flights', 'put_to_vote'] })).toMatchObject({ ok: false });
  });

  // Staging, 9 Oct: "Pool villas in North Goa under 15k for 4" answered itself from the kept pool stays, an apartment hotel
  // among them. A kind of stay, an amenity or a preference is the model's to map onto ixigo's filters or pick on.
  it('5. not when it names anything the read does not hold: a kind of stay, an amenity, a preference, however it is put', () => {
    const POOL_UNDER: TravelQuery = { ...VILLAS, maxPriceMinor: 1_500_000, guests: 4 };
    expect(plain('stays', POOL_UNDER, 'Pool villas in North Goa under 15k for 4 @Go')).toMatchObject({ ok: false, why: 'asks more ("villas")' });
    expect(plain('stays', POOL_UNDER, '@Go stays with a pool in North Goa under 15k for 4 people')).toEqual({ ok: true });
    // Asks nobody wrote a rule for.
    expect(plain('stays', VILLAS, '@Go pet friendly stays with a pool in North Goa')).toMatchObject({ ok: false, why: 'asks more ("pet")' });
    expect(plain('stays', VILLAS, '@Go beachfront stays with a pool in North Goa')).toMatchObject({ ok: false, why: 'asks more ("beachfront")' });
    expect(plain('flights', FLIGHTS, '@Go morning flights Delhi to Goa Friday after 7 pm')).toMatchObject({ ok: false, why: 'asks more ("morning")' });
    // A filter of ixigo's own the search applies holds its words.
    expect(plain('stays', { ...VILLAS, siteFilters: ['Pet-friendly property'] }, '@Go pet friendly stays with a pool in North Goa')).toEqual({ ok: true });
    // The dates, the head count and the trip's own place are the read's.
    expect(plain('stays', { area: 'anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09' }, '@Go stays in Anjuna, Goa for our dates')).toEqual({ ok: true });
  });

  it('6. not when the search is not the one the message asks for (the model searched from earlier context)', () => {
    expect(plain('flights', FLIGHTS, '@Go yes, do that')).toMatchObject({ ok: false, why: 'not read as this search' });
    // Read as Friday 6 Nov, the trip's Friday: a search for another day is not this ask.
    expect(plain('flights', { ...FLIGHTS, date: '2026-10-09' }, '@Go flights Delhi to Goa Friday after 7 pm')).toMatchObject({ ok: false, why: 'not the search asked for' });
    // A condition the read took that the search dropped.
    expect(plain('flights', { from: 'delhi', to: 'goa', date: '2026-11-06' }, '@Go flights Delhi to Goa Friday after 7 pm')).toMatchObject({ ok: false });
  });

  it('7. not on a proactive or wake turn, or a message not to Go, nor a tool run with no wake items at all', () => {
    const tap: DeskItem = { id: 'tap:1', tripId: 't_goa', kind: 'tap', ref: 'tap_1', dueAt: new Date(), payload: {} };
    expect(plain('flights', FLIGHTS, '@Go flights Delhi to Goa Friday after 7 pm', { wake: [tap] })).toMatchObject({ ok: false, why: 'not one message' });
    const search: DeskItem = { ...tap, id: 'search:1', kind: 'search' };
    expect(plain('flights', FLIGHTS, '@Go flights Delhi to Goa Friday after 7 pm', { wake: [search] })).toMatchObject({ ok: false });
    expect(plain('flights', FLIGHTS, 'flights Delhi to Goa Friday after 7 pm', { namesGo: false })).toMatchObject({ ok: false, why: 'not to Go' });
    expect(plainAsk('flights', FLIGHTS, { wake: undefined as never, pack: undefined as never, today: TODAY })).toMatchObject({ ok: false, why: 'not one message' });
  });

  it("8. not when the ask isn't plainly English: the model answers in the group's language", () => {
    expect(plain('flights', { from: 'delhi', to: 'goa', date: '2026-10-08' }, 'Go Delhi se Goa flights kal ke dikhao')).toMatchObject({ ok: false, why: 'not plainly English' });
    expect(plainEnglish('@Go दिल्ली से गोवा flights')).toBe(false);
    expect(plainEnglish('@Go flights Delhi to Goa Friday 🌴')).toBe(true);
  });
});

const priced = (kind: TravelOption['kind'], title: string, priceMinor: number, o: Partial<TravelOption> = {}): TravelOption => ({
  kind, title, priceMinor, currency: 'INR', priceNote: kind === 'stay' ? 'per night, per room' : kind === 'bus' ? 'per seat, from' : 'per person', highlights: [], facts: {}, ...o,
});
const leaving = (at: string, number?: string) => ({ journey: { mode: 'flight' as const, origin: { name: 'Delhi' }, destination: { name: 'Goa' }, depart_at: `2026-11-06T${at}:00+05:30`, arrive_at: '2026-11-06T23:00:00+05:30', ...(number ? { number } : {}) } });

describe("the card's line, built from the options the card shows", () => {
  it('says the scope, the conditions and the cheapest price on the card, never a count', () => {
    const stays = [priced('stay', 'Casa Azul', 1_200_000), priced('stay', 'Meritas', 433_400), priced('stay', 'Villa Sol', 980_000)];
    expect(answerLine('stays', VILLAS, stays)).toBe('Pool stays in North Goa for 6 to 9 Nov, from ₹4,334 a night.');
    const flights = [priced('flight', 'IndiGo 6E 2134', 420_000), priced('flight', 'Air India', 389_000)];
    expect(answerLine('flights', FLIGHTS, flights)).toBe('Flights Delhi to Goa on Fri 6 Nov, leaving after 7:00 pm, from ₹3,890 per person.');
    const buses = [priced('bus', 'Paulo Travels', 150_000)];
    expect(answerLine('buses', { from: 'mumbai', to: 'goa', date: '2026-11-05' }, buses)).toBe('Buses Mumbai to Goa on Thu 5 Nov, from ₹1,500 per seat.');
    expect(answerLine('stays', { area: 'goa', checkIn: '2026-11-30', checkOut: '2026-12-02' }, stays)).toBe('Stays in Goa for 30 Nov to 2 Dec, from ₹4,334 a night.');
  });

  // The exam, 10 Oct (#5): a line for five said "from ₹621 per night, per room". With the stays' totals, it says the
  // cheapest whole stay and each share, as the card's price does; a night's stays only for stays with no total (above).
  it("says stays' from as the cheapest whole stay and each person's share when the stays have totals", () => {
    const whole = (title: string, night: number, rooms: number) => priced('stay', title, night, { totalMinor: night * 3 * rooms, facts: { nights: 3, rooms, guests: 5 } });
    // The cheapest night (₹500 a room, five rooms: ₹7,500) is not the cheapest stay: three rooms at ₹621 are (₹5,589).
    expect(answerLine('stays', VILLAS, [whole('Dorm by the Sea', 50_000, 5), whole('Sea Breeze Rooms', 62_100, 3)]))
      .toBe('Pool stays in North Goa for 6 to 9 Nov, from ₹5,589 for 3 nights, 3 rooms, about ₹1,100 each.');
  });

  it("for a link, says where they are, who they're set for, and that Go notes a pick but books nothing", () => {
    expect(linkLine('flights', FLIGHTS, 'for 3 from Delhi')).toBe(
      'Flights Delhi to Goa on Fri 6 Nov are on ixigo, set for 3 from Delhi, leaving after 7:00 pm: book there, and tell me which one so I can note it for the group.',
    );
    // What the link can't set, the group picks on ixigo's page: an ask nobody wrote an argument for.
    expect(linkLine('flights', { ...FLIGHTS, wants: ['IndiGo only', 'a window seat'] }, 'for 3 from Delhi')).toBe(
      'Flights Delhi to Goa on Fri 6 Nov are on ixigo, set for 3 from Delhi, leaving after 7:00 pm (for IndiGo only and a window seat, pick on the page): ' +
        'book there, and tell me which one so I can note it for the group.',
    );
  });

  // Staging, 9 Oct: "leaving after 6:00 pm" on a fresh trip, a time nobody in the chat had said, read as made up.
  it('says why a time the trip gave applies, with the time, on the card line and the link line alike', () => {
    const fromTrip: TravelQuery = { from: 'delhi', to: 'goa', date: '2026-11-06', departAfter: '18:00', because: 'because Rahul can leave Friday after 6 pm.' };
    const flights = [priced('flight', 'Air-India Express IX1196', 863_000)];
    expect(answerLine('flights', fromTrip, flights)).toBe('Flights Delhi to Goa on Fri 6 Nov, leaving after 6:00 pm, because Rahul can leave Friday after 6 pm, from ₹8,630 per person.');
    expect(linkLine('flights', fromTrip, null)).toBe(
      'Flights Delhi to Goa on Fri 6 Nov are on ixigo, leaving after 6:00 pm, because Rahul can leave Friday after 6 pm: book there, and tell me which one so I can note it for the group.',
    );
    // With no time, there is nothing to explain.
    expect(answerLine('flights', { from: 'delhi', to: 'goa', date: '2026-11-06', because: 'Rahul can leave Friday after 6 pm' }, flights)).toBe('Flights Delhi to Goa on Fri 6 Nov, from ₹8,630 per person.');
  });
});

describe("the card's title, built from the search as the model's titles read", () => {
  it('stays: the kind with its condition, the place, and the stay\'s dates', () => {
    expect(answerTitle('stays', VILLAS)).toBe('Pool stays in North Goa, 6 to 9 Nov');
    expect(answerTitle('stays', { area: 'anjuna', checkIn: '2026-11-30', checkOut: '2026-12-02' })).toBe('Stays in Anjuna, 30 Nov to 2 Dec');
  });

  it('buses, trains and flights: the kind, the places and the day (the buses card had lost its date)', () => {
    expect(answerTitle('buses', { from: 'mumbai', to: 'goa', date: '2026-11-06' })).toBe('Buses, Mumbai to Goa, 6 Nov');
    expect(answerTitle('trains', { from: 'mumbai', to: 'madgaon', date: '2026-11-05' })).toBe('Trains, Mumbai to Madgaon, 5 Nov');
    expect(answerTitle('flights', FLIGHTS)).toBe('Flights, Delhi to Goa, 6 Nov');
    expect(answerTitle('flights', { ...FLIGHTS, mustHave: ['non_stop'] })).toBe('Non-stop flights, Delhi to Goa, 6 Nov');
  });
});

describe("the card's picks", () => {
  it("takes the engine's first three stays, which hold its conditions, rating and spread", () => {
    const stays = ['A', 'B', 'C', 'D'].map((t) => toResultOption(priced('stay', t, 500_000)));
    expect(directPicks('stays', stays)).toEqual([1, 2, 3]);
  });

  it('takes the three cheapest journeys that fit, shown by departure, one fare a train', () => {
    const flights = [
      priced('flight', 'F1', 900_000, leaving('06:00')), priced('flight', 'F2', 400_000, leaving('21:00')), priced('flight', 'F3', 500_000, leaving('10:00')),
      priced('flight', 'F4', 450_000, leaving('15:00')), priced('flight', 'F5', 700_000, leaving('08:00')),
    ].map(toResultOption);
    expect(directPicks('flights', flights)).toEqual([3, 4, 2]);
    const trains = [
      priced('train', '12051 3A', 200_000, leaving('05:00', '12051')), priced('train', '12051 SL', 80_000, leaving('05:00', '12051')),
      priced('train', '10103 SL', 90_000, leaving('07:00', '10103')), priced('train', '22119 2S', 60_000, leaving('13:00', '22119')),
    ].map(toResultOption);
    expect(directPicks('trains', trains)).toEqual([2, 3, 4]);
  });
});

import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import type { TripEvent } from '../../door/methods.js';
import type { TripPack } from '../../trips/pack.js';
import { createItinerary, itineraryOf, sameItinerary, type Day } from '../itinerary.js';

// Prod, 11 Oct (Keshav: "itinerary is not working"): the App's Itinerary tab shows the trip's stored itinerary, which Go
// never wrote. Go writes it from the trip's dates and bookings, keeping every item people added.

const booking = (b: Record<string, unknown>) =>
  C.Booking.parse({ status: 'confirmed', vendor: 'ixigo', ref: 'R1', amount_minor: 100, currency: 'INR', payer_person_id: 'p_rahul', created_at: '2026-10-11T10:00:00Z', ...b });
const VILLA = booking({
  booking_id: 'b_villa', kind: 'stay', title: 'Villa Sol, 3 nights', for_person_ids: ['p_rahul', 'p_priya'], place: { name: 'Villa Sol' },
  starts_at: '2026-11-06T14:00:00+05:30', ends_at: '2026-11-09T11:00:00+05:30', decision_id: 'd_villa',
});
const RAHUL = booking({
  booking_id: 'b_fl_rahul', kind: 'flight', title: 'IndiGo 6E 2134', for_person_ids: ['p_rahul'],
  journey: { mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOI' }, depart_at: '2026-11-06T06:10:00+05:30', arrive_at: '2026-11-06T08:45:00+05:30', carrier_code: '6E', number: '2134' },
  return_journey: { mode: 'flight', origin: { name: 'Goa', code: 'GOI' }, destination: { name: 'Delhi', code: 'DEL' }, depart_at: '2026-11-09T19:00:00+05:30', arrive_at: '2026-11-09T21:40:00+05:30', carrier_code: '6E', number: '6E 517' },
});
const PRIYA = booking({
  booking_id: 'b_fl_priya', kind: 'flight', title: 'Air India AI 501', for_person_ids: ['p_priya'],
  journey: { mode: 'flight', origin: { name: 'Bengaluru', code: 'BLR' }, destination: { name: 'Goa', code: 'GOI' }, depart_at: '2026-11-06T09:30:00+05:30', arrive_at: '2026-11-06T10:45:00+05:30', carrier_name: 'Air India', number: 'AI 501' },
});
type Trip = Parameters<typeof itineraryOf>[0];
const trip = (o: Partial<Trip> = {}): Trip => ({
  dates: { start: '2026-11-06', end: '2026-11-09' },
  destination: { name: 'Goa', timezone: 'Asia/Kolkata' },
  people: [{ person_id: 'p_rahul' }, { person_id: 'p_priya' }] as Trip['people'],
  bookings: [VILLA, RAHUL, PRIYA],
  itinerary: [],
  ...o,
});
const valid = (days: Day[]) => C.UpdateTrip.parse({ request_id: 'r_1', trip_id: 't_goa', itinerary: days }).itinerary;

describe("the trip's itinerary from its dates and bookings", () => {
  it('makes one day per date, the stay in and out, and each person\'s flights on their days, for them', () => {
    const days = itineraryOf(trip())!;
    expect(valid(days)).toEqual(days);
    expect(days.map((d) => [d.date, d.title])).toEqual([['2026-11-06', 'Arrive'], ['2026-11-07', 'Day 2'], ['2026-11-08', 'Day 3'], ['2026-11-09', 'Head home']]);
    expect(days[0]!.items).toEqual([
      { item_id: 'b_fl_rahul_go', time: '06:10', title: 'Fly DEL → GOI · 6E 2134', booking_id: 'b_fl_rahul', status: 'booked', category: 'getting_around', person_ids: ['p_rahul'], audience: 'shared' },
      { item_id: 'b_fl_priya_go', time: '09:30', title: 'Fly BLR → GOI · AI 501', booking_id: 'b_fl_priya', status: 'booked', category: 'getting_around', person_ids: ['p_priya'], audience: 'shared' },
      { item_id: 'b_villa_in', time: '14:00', title: 'Check in at Villa Sol', booking_id: 'b_villa', status: 'booked', category: 'stay', audience: 'group' },
    ]);
    expect(days[1]!.items).toEqual([]);
    expect(days[3]!.items.map((i) => [i.time, i.title])).toEqual([['11:00', 'Check out of Villa Sol'], ['19:00', 'Fly GOI → DEL · 6E 517']]);
  });

  it('written again changes nothing', () => {
    const first = itineraryOf(trip())!;
    const again = itineraryOf(trip({ itinerary: first }))!;
    expect(again).toEqual(first);
    expect(sameItinerary(again, first)).toBe(true);
  });

  it("keeps every item and day title people added, and drops a cancelled booking's items", () => {
    const first = itineraryOf(trip())!;
    const stored: Day[] = first.map((d) =>
      d.date === '2026-11-07'
        ? { ...d, items: [{ item_id: 'it_beach', title: 'Beach at Anjuna', category: 'activities', status: 'planned' }] }
        : d.date === '2026-11-08' ? { ...d, title: 'Spa day' } : d,
    );
    const priyaGone = { ...PRIYA, status: 'cancelled' as const };
    const days = itineraryOf(trip({ itinerary: stored, bookings: [VILLA, RAHUL, priyaGone] }))!;
    expect(valid(days)).toEqual(days);
    expect(days[1]!.items).toEqual([{ item_id: 'it_beach', title: 'Beach at Anjuna', category: 'activities', status: 'planned' }]);
    expect(days[2]!.title).toBe('Spa day');
    expect(days[0]!.items.map((i) => i.booking_id)).toEqual(['b_fl_rahul', 'b_villa']);
  });

  it('writes nothing for a trip with no booking and nothing booked stored', () => {
    expect(itineraryOf(trip({ bookings: [] }))).toBeNull();
  });

  it('places the bookings by their own dates when the trip has none', () => {
    const days = itineraryOf(trip({ dates: null }))!;
    expect(days.map((d) => d.date)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
  });
});

describe('keeping it in line', () => {
  const ev = (type: string, data: Record<string, unknown>) => ({ event_id: `ev_${type}`, trip_id: 't_goa', seq: 1, occurred_at: '2026-10-11T10:00:00Z', type, data }) as unknown as TripEvent;

  it("writes on a trip's first event and on a booking change, never twice for the same, never on its own write", async () => {
    const t = trip({ bookings: [VILLA] });
    const writes: Array<Record<string, unknown>> = [];
    const keeper = createItinerary({
      link: {
        request: (async (method: string, params: Record<string, unknown>) => {
          writes.push({ method, ...params });
          t.itinerary = params['itinerary'] as Day[];
          return { seq: 2 };
        }) as never,
      },
      packs: { get: async () => ({ trip: t, messages: [], seq: 1 }) as unknown as TripPack },
      log: { info: () => undefined, warn: () => undefined },
    });
    // The trip's first event since Go started: its itinerary is written from what is booked.
    keeper.onEvent(ev('message.created', {}));
    await keeper.settled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'update_trip', trip_id: 't_goa' });
    // The same bookings again: nothing to write.
    keeper.onEvent(ev('booking.changed', {}));
    await keeper.settled();
    expect(writes).toHaveLength(1);
    // Go's own write comes back as trip.updated with "itinerary": it wakes nothing.
    t.bookings = [VILLA, RAHUL];
    keeper.onEvent(ev('trip.updated', { changed: ['itinerary'] }));
    await keeper.settled();
    expect(writes).toHaveLength(1);
    // A booking change writes the new flight in.
    keeper.onEvent(ev('booking.changed', {}));
    await keeper.settled();
    expect(writes).toHaveLength(2);
    expect((writes[1]!['itinerary'] as Day[])[0]!.items.map((i) => i.item_id)).toEqual(['b_fl_rahul_go', 'b_villa_in']);
  });
});

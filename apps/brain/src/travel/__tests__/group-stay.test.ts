import { describe, expect, it } from 'vitest';
import type { Trip } from '../../door/methods.js';
import { createGroupStay, kmBetween, nearStay } from '../group-stay.js';
import type { OptionPlace } from '../results.js';
import type { TravelOption, TravelSearch } from '../travel.js';

// The lead, 10 Oct: buses have many drops; Go names the one nearest the group's stay, in a straight line ("about 3 km"),
// and says whose stay it is. The group's stay: the booked one, else the vote's winner, else the latest card's top pick.
const ANJUNA = { lat: 15.5733, lng: 73.74 };
const stayOption = (title: string, at: { lat: number; lng: number } | null): OptionPlace => ({
  kind: 'stay', title, place: at ? { name: title, address: null, ...at } : { name: title, address: null }, area: 'Anjuna',
});

function tripWith(over: { bookings?: unknown[]; decisions?: unknown[] }): Trip {
  return { bookings: [], decisions: [], ...over } as unknown as Trip;
}

const vote = (id: string, refs: Array<string | null>, winner: number | null, closedAt: string) => ({
  decision_id: id, status: 'closed', result_index: winner, closed_at: closedAt,
  options: refs.map((r, i) => ({ label: `Option ${i + 1}`, option_ref: r })),
});

function groupStayOf(trip: Trip, places: Record<string, OptionPlace>, top: OptionPlace | null = null) {
  return createGroupStay({
    trip: async () => trip,
    results: { placeOf: async (id: string) => places[id] ?? null, topPick: async () => top },
  });
}

describe("the group's stay", () => {
  it('is the booked stay, by its own position, else its vote\'s winning option\'s; never another stay when it has none', async () => {
    const booking = (over: Record<string, unknown>) => ({ kind: 'stay', status: 'confirmed', title: 'Casa Anjuna', created_at: '2026-10-09T10:00:00Z', ...over });
    const own = groupStayOf(tripWith({ bookings: [booking({ place: { name: 'Casa Anjuna', ...ANJUNA } })] }), {});
    expect(await own('t')).toEqual({ name: 'Casa Anjuna', ...ANJUNA, why: 'booked' });
    const fromVote = groupStayOf(
      tripWith({ bookings: [booking({ decision_id: 'd_stay' })], decisions: [vote('d_stay', ['opt_a', 'opt_b'], 1, '2026-10-09T09:00:00Z')] }),
      { opt_b: stayOption('Casa Anjuna', ANJUNA) },
    );
    expect(await fromVote('t')).toEqual({ name: 'Casa Anjuna', ...ANJUNA, why: 'booked' });
    // Booked with no position anywhere: no stay, even with another vote's winner placed.
    const unplaced = groupStayOf(
      tripWith({ bookings: [booking({})], decisions: [vote('d_other', ['opt_c', 'opt_d'], 0, '2026-10-09T09:00:00Z')] }),
      { opt_c: stayOption('Villa Sol', ANJUNA) },
    );
    expect(await unplaced('t')).toBeNull();
  });

  it("is the newest closed vote's winning stay, past votes on other things; else the latest card's top pick; else none", async () => {
    const voted = groupStayOf(
      tripWith({
        decisions: [
          vote('d_old', ['opt_old', 'opt_x'], 0, '2026-10-08T09:00:00Z'),
          vote('d_dates', [null, null], 0, '2026-10-09T12:00:00Z'),
          vote('d_new', ['opt_x', 'opt_new'], 1, '2026-10-09T11:00:00Z'),
          { ...vote('d_tied', ['opt_old', 'opt_new'], null, '2026-10-09T13:00:00Z') },
        ],
      }),
      { opt_old: stayOption('Villa Sol', { lat: 15.55, lng: 73.75 }), opt_new: stayOption('Casa Anjuna', ANJUNA) },
    );
    expect(await voted('t')).toEqual({ name: 'Casa Anjuna', ...ANJUNA, why: 'voted' });
    const top = groupStayOf(tripWith({}), {}, stayOption('The Palms Villa', { lat: 15.55, lng: 73.75 }));
    expect(await top('t')).toEqual({ name: 'The Palms Villa', lat: 15.55, lng: 73.75, why: 'top' });
    expect(await groupStayOf(tripWith({}), {}, stayOption('No Map Villa', null))('t')).toBeNull();
    expect(await groupStayOf(tripWith({}), {})('t')).toBeNull();
  });
});

describe("each bus's nearest drop to the stay", () => {
  const bus = (title: string, facts: Record<string, string>): TravelOption => ({
    kind: 'bus', title, priceMinor: 150_000, currency: 'INR', priceNote: 'per seat, from', highlights: ['AC Sleeper (2+1)', '11 h 30 m'], facts,
  });
  const found = (results: TravelOption[]): TravelSearch => ({ results, checkedAt: '2026-10-10T06:00:00.000Z' });

  it('says the nearest placed drop first, in a straight line, and whose stay it is; a bus with none placed is left as it is', () => {
    expect(Math.round(kmBetween(ANJUNA, { lat: 15.589, lng: 73.8099 }))).toBe(8);
    const got = nearStay(
      found([
        bus('Paulo Travels Express', { dropping_points: 'Panjim; Mapusa; Madgaon', drop_spots: 'Panjim (15.4939, 73.8369); Mapusa (15.589, 73.8099)' }),
        bus('VRL Travels', { dropping_points: 'Madgaon' }),
      ]),
      { name: 'Casa Anjuna', ...ANJUNA, why: 'voted' },
    );
    expect(got.results[0]!.highlights).toEqual(['Get off at Mapusa, about 8 km from Casa Anjuna', 'AC Sleeper (2+1)', '11 h 30 m']);
    expect(got.results[0]!.facts).toMatchObject({ get_off: 'Mapusa', get_off_km: 7.7 });
    expect(got.results[1]).toEqual(bus('VRL Travels', { dropping_points: 'Madgaon' }));
    expect(got.nearStay).toBe('Casa Anjuna, the stay you voted for');
    // A stay right by the drop, and no stay at all.
    const by = nearStay(found([bus('Paulo', { drop_spots: 'Mapusa (15.589, 73.8099)' })]), { name: 'Hotel Mapusa', lat: 15.588, lng: 73.809, why: 'booked' });
    expect(by.results[0]!.highlights[0]).toBe('Get off at Mapusa, under 1 km from Hotel Mapusa');
    const none = found([bus('Paulo', { drop_spots: 'Mapusa (15.589, 73.8099)' })]);
    expect(nearStay(none, null)).toBe(none);
    // No bus with a placed drop: the search as it was, saying no stay.
    const unplaced = found([bus('VRL Travels', { dropping_points: 'Madgaon' })]);
    expect(nearStay(unplaced, { name: 'Casa Anjuna', ...ANJUNA, why: 'top' })).toBe(unplaced);
  });
});

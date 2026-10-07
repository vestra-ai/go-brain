import { describe, expect, it } from 'vitest';
import { readTravelAsk } from '../ask.js';
import { RECIPES } from '../index.js';

// Wednesday 7 Oct 2026, the Goa trip: North Goa, 6 to 9 Nov.
const CTX = { today: '2026-10-07', destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' } };
const read = (text: string) => readTravelAsk(text, CTX);

describe('reading a travel ask', () => {
  it("reads the test set's travel asks, English and Hinglish, into queries the recipes can fill", () => {
    // c03
    expect(read("@Go flights Delhi to Goa Friday evening, Arjun can't leave before 6")).toEqual({ kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-10-09' } });
    // c05: no dates of its own, so the trip's.
    expect(read('Go find us a villa with a private pool in North Goa under 8k a head, close to the beach')).toEqual({
      kind: 'stays', query: { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09' },
    });
    // c30: from Mumbai, to the trip's destination.
    expect(read('can someone check trains from Mumbai on Thursday?')).toEqual({ kind: 'trains', query: { from: 'mumbai', to: 'North Goa', date: '2026-10-08' } });
    for (const ask of [read("@Go flights Delhi to Goa Friday evening, Arjun can't leave before 6"), read('can someone check trains from Mumbai on Thursday?')]) {
      expect(() => RECIPES[ask!.kind].slotsFrom(ask!.query, { people: 5 })).not.toThrow();
    }
  });

  it('reads Hinglish directions and days', () => {
    expect(read('Go Delhi se Goa flights kal ke dikhao')).toEqual({ kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-10-08' } });
    expect(read('Go Goa ke liye Delhi se flight parso')).toEqual({ kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-10-09' } });
    expect(read('Go Mumbai se Goa bus 6 Nov, 5 log')).toEqual({ kind: 'buses', query: { from: 'mumbai', to: 'goa', date: '2026-11-06', guests: 5 } });
  });

  it('reads dates as people write them, and stays with their own dates and nights', () => {
    expect(read('@Go flights BOM to GOI on Nov 6')?.query).toEqual({ from: 'BOM', to: 'GOI', date: '2026-11-06' });
    expect(read('@Go trains Mumbai to Madgaon 6/11')?.query).toMatchObject({ date: '2026-11-06' });
    // A day already past this year is next year's.
    expect(read('@Go flights Delhi to Goa 3rd Jan')?.query).toMatchObject({ date: '2027-01-03' });
    expect(read('@Go hotels in Anjuna 6 to 9 Nov for 4 people')).toEqual({ kind: 'stays', query: { area: 'anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 4 } });
    expect(read('@Go villa in Vagator from 7 Nov, 2 nights')?.query).toMatchObject({ area: 'vagator', checkIn: '2026-11-07', checkOut: '2026-11-09' });
    // "Friday" said on a Friday is next week's.
    expect(readTravelAsk('@Go flights Delhi to Goa Friday', { ...CTX, today: '2026-10-09' })?.query).toMatchObject({ date: '2026-10-16' });
  });

  it('gives nothing for less than one whole search of one kind', () => {
    // No date.
    expect(read('@Go flights Delhi to Goa?')).toBeNull();
    // One place, no direction.
    expect(read('@Go flights to Goa Friday')).toBeNull();
    // A place the bus table does not know (c47).
    expect(read('Go Thursday raat ki bus Bangalore se Goa dikha')).toBeNull();
    // Two kinds at once.
    expect(read('@Go flights and a villa for Friday from Delhi to Goa')).toBeNull();
    // Not travel.
    expect(read('Go what is the weather in Goa next week?')).toBeNull();
    // A stay with no place, on a trip with no destination.
    expect(readTravelAsk('@Go find a villa 6 to 9 Nov', { today: '2026-10-07' })).toBeNull();
  });
});

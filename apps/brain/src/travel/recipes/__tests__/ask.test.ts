import { describe, expect, it } from 'vitest';
import { readTravelAsk } from '../ask.js';
import { RECIPES } from '../index.js';

// Wednesday 7 Oct 2026, the Goa trip: North Goa, 6 to 9 Nov.
const CTX = { today: '2026-10-07', destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' } };
const read = (text: string) => readTravelAsk(text, CTX);

describe('reading a travel ask', () => {
  it("reads the test set's travel asks, English and Hinglish, into queries the recipes can fill", () => {
    // c03
    expect(read("@Go flights Delhi to Goa Friday evening, Arjun can't leave before 6")).toEqual({ kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-10-09', departAfter: '18:00' } });
    // c05: no dates of its own, so the trip's.
    expect(read('Go find us a villa with a private pool in North Goa under 8k a head, close to the beach')).toEqual({
      kind: 'stays', query: { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] },
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
    // The must-haves ixigo filters a stay on; "non-refundable" is not free cancellation.
    expect(read('@Go hotel in Candolim with breakfast and free cancellation')?.query.mustHave).toEqual(['breakfast', 'free_cancellation']);
    expect(read('@Go hotel in Candolim, non-refundable is fine')?.query).not.toHaveProperty('mustHave');
    // "Friday" said on a Friday is next week's.
    expect(readTravelAsk('@Go flights Delhi to Goa Friday', { ...CTX, today: '2026-10-09' })?.query).toMatchObject({ date: '2026-10-16' });
  });

  it("reads a journey's clear conditions, so the turn's answer already holds them: times, evening, non-stop, a cap per person", () => {
    const q = (text: string) => read(text)?.query;
    // The bench's asks (goa-50 L9, goa-300 L122): the later of "evening" and "can't leave before 6".
    expect(q("@Go flights Delhi to Goa Friday evening? Arjun can't leave before 6")).toMatchObject({ departAfter: '18:00' });
    expect(q('@Go flights from Bangalore to Goa on Friday after 7 pm?')).toMatchObject({ departAfter: '19:00' });
    expect(q("@Go flights Delhi to Goa Friday, I can't leave till 7:30 pm")).toMatchObject({ departAfter: '19:30' });
    expect(q('Go Mumbai se Goa bus 6 Nov shaam ko, 5 log')).toMatchObject({ departAfter: '17:00', guests: 5 });
    expect(q('@Go flights Delhi to Goa Friday after 11 am before 3 pm')).toMatchObject({ departAfter: '11:00', departBefore: '15:00' });
    expect(q('@Go trains Mumbai to Madgaon 6/11 arriving before 10 am')).toMatchObject({ arriveBefore: '10:00' });
    expect(q('@Go flights Delhi to Goa 6 Nov, need to reach by 2 pm')).toMatchObject({ arriveBefore: '14:00' });
    expect(q('@Go non-stop flights Delhi to Goa Friday under 6k')).toMatchObject({ mustHave: ['non_stop'], maxPriceMinor: 600_000 });
    expect(q('@Go direct flights BOM to GOI on Nov 6 below ₹5,500 per person')).toMatchObject({ mustHave: ['non_stop'], maxPriceMinor: 550_000 });
    expect(q('@Go buses Mumbai to Goa 6 Nov under 1500')).toMatchObject({ maxPriceMinor: 150_000 });
  });

  it('leaves what could mean two things to the model: a bare hour, hours, a cap for everyone, a stay\'s price or the beach', () => {
    const bare = { from: 'delhi', to: 'goa', date: '2026-10-09' };
    expect(read('@Go flights Delhi to Goa Friday after 7')?.query).toEqual(bare);
    expect(read('@Go flights Delhi to Goa Friday under 2 hours')?.query).toEqual(bare);
    expect(read('@Go flights Delhi to Goa Friday under 30k total')?.query).toEqual(bare);
    expect(read('@Go flights Delhi to Goa after 6 Nov')?.query).toEqual({ from: 'delhi', to: 'goa', date: '2026-11-06' });
    expect(read('Go find us a villa with a private pool in North Goa under 8k a head, close to the beach')?.query).toEqual({
      area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'],
    });
  });

  it("takes Jev's kind when it is sure, over the kind words", () => {
    expect(readTravelAsk('@Go Mumbai se Goa kal kuch hai kya', { ...CTX, kind: 'buses' })).toEqual({ kind: 'buses', query: { from: 'mumbai', to: 'goa', date: '2026-10-08' } });
    expect(readTravelAsk('@Go flights and a villa for Friday from Delhi to Goa', { ...CTX, kind: 'flights' })?.kind).toBe('flights');
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
    // Another job about a stay or a flight, which the trip's place and dates would otherwise make a search (bench lines).
    expect(read('@Go put the three villas to a vote please')).toBeNull();
    expect(read('Go bhai abhi book kar de villa, Rahul ka card use kar le')).toBeNull();
    expect(read('@Go is the villa booked? Who paid the advance?')).toBeNull();
    // A stay with no place, on a trip with no destination.
    expect(readTravelAsk('@Go find a villa 6 to 9 Nov', { today: '2026-10-07' })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { agreedDates, readTravelAsk } from '../ask.js';
import { airportOf, stationOf } from '../places.js';

// Wednesday 7 Oct 2026, the Goa trip: North Goa, 6 to 9 Nov.
const CTX = { today: '2026-10-07', destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' } };
const read = (text: string) => readTravelAsk(text, CTX);

describe('reading a travel ask', () => {
  it("reads the test set's travel asks, English and Hinglish, into queries the recipes can fill", () => {
    // c03
    // c03: the trip's Friday, 6 Nov, not this week's.
    expect(read("@Go flights Delhi to Goa Friday evening, Arjun can't leave before 6")).toEqual({ kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-11-06', departAfter: '18:00' } });
    // c05: no dates of its own, so the trip's.
    expect(read('Go find us a villa with a private pool in North Goa under 8k a head, close to the beach')).toEqual({
      kind: 'stays', query: { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] },
    });
    // c30: from Mumbai, to the trip's destination.
    // The day before the trip starts: an overnight train.
    expect(read('can someone check trains from Mumbai on Thursday?')).toEqual({ kind: 'trains', query: { from: 'mumbai', to: 'North Goa', date: '2026-11-05' } });
    for (const ask of [read("@Go flights Delhi to Goa Friday evening, Arjun can't leave before 6"), read('can someone check trains from Mumbai on Thursday?')]) {
      // Places Go has searched before: the search opens its results page with no lookup.
      for (const words of [ask!.query.from!, ask!.query.to!]) expect(() => (ask!.kind === 'flights' ? airportOf : stationOf)(words)).not.toThrow();
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
    // Once the trip is over, "Friday" is the coming one, and "Friday" said on a Friday is next week's.
    expect(readTravelAsk('@Go flights Delhi to Goa Friday', { ...CTX, today: '2026-11-13' })?.query).toMatchObject({ date: '2026-11-20' });
  });

  it("leaves a day of the week to the model on a trip with no dates yet: this week's or the trip's, only the chat says", () => {
    // Measurement run 37582427795: "Friday" read as 9 Oct on the 6 to 9 Nov trip, and the model searched again for 6 Nov.
    const undated = { ...CTX, dates: null };
    expect(readTravelAsk("@Go flights Delhi to Goa Friday evening? Arjun can't leave before 6", undated)).toBeNull();
    expect(readTravelAsk('Go find us a villa with a pool in North Goa', undated)).toBeNull();
    // A date of its own, or "tomorrow", needs no trip.
    expect(readTravelAsk('@Go which days are cheapest to fly Delhi to Goa around 6 Nov?', undated)?.query).toEqual({ from: 'delhi', to: 'goa', date: '2026-11-06' });
    expect(readTravelAsk('Go Delhi se Goa flights kal ke dikhao', undated)?.query).toMatchObject({ date: '2026-10-08' });
  });

  it("finds the trip's dates in its record when the trip has none set: the one range its decided or agreed lines give", () => {
    const line = (kind: string, text: string, status = 'active') => ({ kind, text, status });
    expect(agreedDates([line('agreed', '6 to 9 Nov, Diwali long weekend'), line('agreed', 'North Goa, not South')], CTX.today)).toEqual({ start: '2026-11-06', end: '2026-11-09' });
    expect(agreedDates([line('decided', '6 to 9 Nov'), line('agreed', 'Diwali weekend, 6-9 Nov')], CTX.today)).toEqual({ start: '2026-11-06', end: '2026-11-09' });
    // An open question, a line someone undid, one day, or two ranges that disagree: none.
    expect(agreedDates([line('open', '6 to 9 Nov?')], CTX.today)).toBeNull();
    expect(agreedDates([line('agreed', '6 to 9 Nov', 'undone')], CTX.today)).toBeNull();
    expect(agreedDates([line('agreed', 'Candolim on 7 Nov')], CTX.today)).toBeNull();
    expect(agreedDates([line('agreed', '6 to 9 Nov'), line('decided', '13 to 16 Nov')], CTX.today)).toBeNull();
    expect(agreedDates([], CTX.today)).toBeNull();
  });

  it("reads a day of the week as the trip's day while the trip is ahead, from the day before it starts to its last", () => {
    const day = (text: string, today = CTX.today) => readTravelAsk(text, { ...CTX, today })?.query;
    expect(day('@Go flights Delhi to Goa Friday')).toMatchObject({ date: '2026-11-06' });
    expect(day('@Go flights Goa to Delhi Monday')).toMatchObject({ date: '2026-11-09' });
    // Said the same Friday the trip starts on: still the trip's, today.
    expect(day('@Go flights Delhi to Goa Friday', '2026-11-06')).toMatchObject({ date: '2026-11-06' });
    // A day the trip doesn't cover, or a trip whose Friday has passed: the coming one.
    expect(day('@Go flights Delhi to Goa Wednesday')).toMatchObject({ date: '2026-10-14' });
    expect(day('@Go flights Delhi to Goa Friday', '2026-11-07')).toMatchObject({ date: '2026-11-13' });
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
    const bare = { from: 'delhi', to: 'goa', date: '2026-11-06' };
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

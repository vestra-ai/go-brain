import { describe, expect, it } from 'vitest';
import { ageOn, classNow, dayLabel, seatWords, trainOf, trainResultsAddress } from '../train-steps.js';

// A train option's own address, as trains.between gives it (the Mandovi, CSMT to Madgaon, 6 Nov).
const MANDOVI = 'https://www.ixigo.com/trains/10103?orgn=CSMT&dstn=MAO&departDate=2026-11-06&quota=GN';

// The day's results page's own seats call (the atlas's trains.md: data.routesData[]{trainCode, availabilities[]{c, q, a, p, f}}).
const SEATS = {
  data: {
    routesData: [
      { trainCode: '12051', availabilities: [{ c: 'CC', q: 'GN', a: 'AVAILABLE 120', p: 0, f: 775 }] },
      {
        trainCode: '10103',
        availabilities: [
          { c: 'SL', q: 'GN', a: 'GNWL 12', p: 47, f: 410 },
          { c: '3A', q: 'GN', a: 'RAC 5', p: 0, f: 1120 },
          { c: '2A', q: 'GN', a: 'AVAILABLE 8', p: 0, f: 1605 },
        ],
      },
    ],
  },
};

describe("a person's own train, as its booking reads it", () => {
  it("starts from the day's search results for its class, from the train option's own address", () => {
    expect(trainOf(MANDOVI)).toEqual({ number: '10103', from: 'CSMT', to: 'MAO', date: '2026-11-06', quota: 'GN' });
    expect(trainResultsAddress(MANDOVI, 'SL')).toBe('https://www.ixigo.com/search/result/train/CSMT/MAO/06112026//1/0/0/0/SL');
    expect(trainResultsAddress(MANDOVI, null)).toBe('https://www.ixigo.com/search/result/train/CSMT/MAO/06112026//1/0/0/0/ALL');
    // A flight's page, or a train page with no day, is no train to book.
    expect(trainOf('https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026')).toBeNull();
    expect(trainOf('https://www.ixigo.com/trains/10103?orgn=CSMT')).toBeNull();
  });

  it("reads the class's seats and fare now from the results page's own call, by train, class and quota", () => {
    expect(classNow(SEATS, '10103', 'SL', 'GN')).toEqual({ status: 'GNWL 12', chance: 47, fareMinor: 41_000 });
    expect(classNow(SEATS, '10103', '2A', 'GN')).toEqual({ status: 'AVAILABLE 8', chance: null, fareMinor: 160_500 });
    expect(classNow(SEATS, '10103', 'SL', 'TQ')).toBeNull();
    expect(classNow(SEATS, '12345', 'SL', 'GN')).toBeNull();
    expect(classNow({ errors: [] }, '10103', 'SL', 'GN')).toBeNull();
  });

  it('says a waitlist or RAC plainly before they pay, and nothing for seats that are there', () => {
    expect(seatWords({ status: 'GNWL 12', chance: 47 })).toBe(
      "It's waitlisted (GNWL 12); ixigo gives it a 47% chance to confirm: a waitlisted ticket that doesn't confirm by the chart is cancelled and refunded.",
    );
    expect(seatWords({ status: 'RAC 5', chance: null })).toBe("It's RAC (RAC 5): you travel on a shared side berth until a full berth frees up.");
    expect(seatWords({ status: 'AVAILABLE 8', chance: null })).toBeNull();
    expect(seatWords({ status: 'REGRET', chance: null })).toBe('ixigo says regret for it now.');
  });

  it('writes a day as the page lists it under a class (p0\'s T1: "Fri, 06 Nov"), September as Sep', () => {
    expect(dayLabel('2026-11-06')).toBe('Fri, 06 Nov');
    expect(dayLabel('2026-09-01')).toBe('Tue, 01 Sep');
    expect(dayLabel('06-11-2026')).toBeNull();
  });

  it("takes a passenger's age in whole years on the day they travel", () => {
    expect(ageOn('1994-11-07', '2026-11-06')).toBe(31);
    expect(ageOn('1994-11-06', '2026-11-06')).toBe(32);
    expect(ageOn('not a day', '2026-11-06')).toBeNull();
  });
});

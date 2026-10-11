import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture } from '../../recipes/__tests__/fixtures.js';
import { chooseRate, stayRates, type StayRate } from '../stay-rates.js';

// Saudades Homestays' own page's rooms call, 20 to 22 Nov, 2 adults, 1 room, as the logged-out drill browser got it
// (H1, 10 Oct; its per-search block ids and tokens blanked): five rooms, one rate each, ixigo's IXIFIRST on each.
type Fare = { totalPGAmount: number };
const ROOMS = JSON.parse(fixture('stays-saudades-rooms.json')) as { data: { rooms: Array<{ roomOptions: Array<{ fareDetail: Fare }> }> } };
// hotels.rooms's older sample: a night's fares only, no whole-stay total.
const NIGHT_ONLY = JSON.parse(readFileSync(new URL('../../../../recipes/samples/hotels.rooms.json', import.meta.url), 'utf8')) as unknown;

describe("a stay's rates, and the one Go books for the group", () => {
  it("prices each rate at what ixigo charges for the whole stay, its coupon taken off, and names the coupon and its saving", () => {
    const rates = stayRates(ROOMS);
    expect(rates.map((r) => [r.room, r.totalMinor, r.coupon, r.refundable, r.recommended])).toEqual([
      ['1 Bedroom Apartment', 547_566, { code: 'IXIFIRST', savingMinor: 11_100 }, true, true],
      ['2 Bedroom Apartment', 1_094_530, { code: 'IXIFIRST', savingMinor: 22_100 }, true, false],
      ['3 Bedroom Apartment', 2_082_924, { code: 'IXIFIRST', savingMinor: 37_500 }, true, false],
      ['3 bedroom villa', 2_314_328, { code: 'IXIFIRST', savingMinor: 41_700 }, true, false],
      ['4 bedroom Villa', 2_777_618, { code: 'IXIFIRST', savingMinor: 50_100 }, true, false],
    ]);
    // Logged out, that is ixigo's own amount to pay, on every rate (Go never reads it: logged in, ixigo money can come off it).
    expect(rates.map((r) => r.totalMinor)).toEqual(ROOMS.data.rooms.map((r) => Math.round(r.roomOptions[0]!.fareDetail.totalPGAmount * 100)));
    expect(rates[0]!.cancellation).toBe('Free Cancellation till 18 Nov 11:59 PM');
  });

  it("says no rate when the call has no whole-stay total: a night's fare is never multiplied out", () => {
    expect(stayRates(NIGHT_ONLY)).toEqual([]);
    expect(stayRates({ data: {} })).toEqual([]);
    expect(stayRates(null)).toEqual([]);
  });

  it('chooses the cheapest whole stay; at one price, the one ixigo recommends', () => {
    const rate = (room: string, rupees: number, recommended = false): StayRate => ({
      room, rate: 'Room Only', totalMinor: rupees * 100, coupon: null, cancellation: null, refundable: true, paymentType: 'PAY_NOW', recommended,
    });
    expect(chooseRate(stayRates(ROOMS))?.room).toBe('1 Bedroom Apartment');
    expect(chooseRate([rate('Deluxe Room', 9_000), rate('Standard Room', 7_000)])?.room).toBe('Standard Room');
    expect(chooseRate([rate('Deluxe Room', 7_000), rate('Standard Room', 7_000, true)])?.room).toBe('Standard Room');
    expect(chooseRate([])).toBeNull();
  });
});

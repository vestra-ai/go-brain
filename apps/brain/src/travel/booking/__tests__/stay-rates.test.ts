import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chooseRate, stayRates, type StayRate } from '../stay-rates.js';

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../recipes/samples/${name}`, import.meta.url), 'utf8'));
// The stay's own page's rooms call (hotels.rooms's samples): two cottages, one rate each, ixigo's IXIFIRST on both; and a
// pay-at-the-hotel stay, whose own payAtHotelAmount is the whole stay ixigo works out.
const ROOMS = sample('hotels.rooms.json');
const PAY_AT_HOTEL = sample('hotels.rooms.pay-at-hotel.json') as { data: { rooms: Array<{ roomOptions: Array<{ fareDetail: { payAtHotelAmount: number } }> }> } };

describe("a stay's rates, and the one Go books for the group", () => {
  it('prices each rate for the whole stay: its nightly fare plus taxes, times the nights and the rooms, never totalPrice', () => {
    const night = stayRates(ROOMS, { nights: 1, rooms: 1 });
    expect(night.map((r) => [r.room.split(' - ')[0], r.totalMinor, r.coupon, r.refundable, r.recommended])).toEqual([
      ['Queen Cottage with Balcony', 1_703_100, { code: 'IXIFIRST', savingMinor: 68_600 }, true, true],
      ['King Cottage with Balcony', 2_189_800, { code: 'IXIFIRST', savingMinor: 88_800 }, true, false],
    ]);
    expect(night[0]!.cancellation).toBe('Free Cancellation till 02 Nov 11:59 PM');
    // 3 nights, 3 rooms: nine times, the coupon's saving too.
    expect(stayRates(ROOMS, { nights: 3, rooms: 3 })[0]).toMatchObject({ totalMinor: 15_327_900, coupon: { code: 'IXIFIRST', savingMinor: 617_400 } });
    // ixigo's own sum agrees: the pay-at-the-hotel sample's first rate, 3 nights, 1 room.
    expect(stayRates(PAY_AT_HOTEL, { nights: 3, rooms: 1 })[0]!.totalMinor).toBe(PAY_AT_HOTEL.data.rooms[0]!.roomOptions[0]!.fareDetail.payAtHotelAmount * 100);
  });

  it('says no rate when the call prices another way, or has no rooms', () => {
    const other = structuredClone(ROOMS) as { data: { metadata: { rateMethod: string } } };
    other.data.metadata.rateMethod = 'per stay for all rooms';
    expect(stayRates(other, { nights: 3, rooms: 1 })).toEqual([]);
    expect(stayRates({ data: {} }, { nights: 3, rooms: 1 })).toEqual([]);
    expect(stayRates(null, { nights: 3, rooms: 1 })).toEqual([]);
  });

  it('chooses the cheapest whole stay; at one price, the one ixigo recommends', () => {
    const rate = (room: string, rupees: number, recommended = false): StayRate => ({
      room, rate: 'Room Only', totalMinor: rupees * 100, coupon: null, cancellation: null, refundable: true, paymentType: 'PAY_NOW', recommended,
    });
    expect(chooseRate([rate('Deluxe Room', 9_000), rate('Standard Room', 7_000)])?.room).toBe('Standard Room');
    expect(chooseRate([rate('Deluxe Room', 7_000), rate('Standard Room', 7_000, true)])?.room).toBe('Standard Room');
    expect(chooseRate([])).toBeNull();
  });
});

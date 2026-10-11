import { describe, expect, it } from 'vitest';
import { roomParts, type Room } from '../rooms.js';

const room = (label: string, person_ids: string[], price_minor: number): Room => ({ label, person_ids, price_minor });

describe("a stay's rooms, as parts of what was paid (REV4 B6)", () => {
  it('gives each room its part in proportion to its price, the last room taking the rounding, adding up exactly', () => {
    const parts = roomParts(5_420_000, [
      room('Deluxe room', ['p_rahul', 'p_priya'], 2_400_000),
      room('Deluxe room', ['p_arjun', 'p_meher'], 2_400_000),
      room('Standard room', ['p_kabir'], 1_800_000),
    ])!;
    expect(parts.map((p) => p.amount_minor)).toEqual([1_970_909, 1_970_909, 1_478_182]);
    expect(parts.reduce((s, p) => s + p.amount_minor, 0)).toBe(5_420_000);
    // What was paid can differ from the card's prices (a coupon, a fare that moved): the parts are of what was paid.
    expect(roomParts(4_800_000, [room('A', ['p_1'], 2_400_000), room('B', ['p_2'], 2_400_000)])!.map((p) => p.amount_minor)).toEqual([2_400_000, 2_400_000]);
  });

  it('weighs exactly, however large the amounts', () => {
    const parts = roomParts(9_007_199_254_740_991, [room('A', ['p_1'], 3_000_000_000_001), room('B', ['p_2'], 7_000_000_000_003)])!;
    expect(parts.reduce((s, p) => s + BigInt(p.amount_minor), 0n)).toBe(9_007_199_254_740_991n);
  });

  it('is one room for one room, and none when the rooms cannot split it', () => {
    expect(roomParts(1_000, [room('Villa', ['p_1', 'p_2'], 5_000)])).toEqual([{ room: room('Villa', ['p_1', 'p_2'], 5_000), amount_minor: 1_000 }]);
    expect(roomParts(1_000, [])).toBeNull();
    expect(roomParts(1_000, [room('A', [], 500), room('B', ['p_2'], 500)])).toBeNull();
    expect(roomParts(1_000, [room('A', ['p_1'], 0), room('B', ['p_2'], 0)])).toBeNull();
    expect(roomParts(1_000, [room('A', ['p_1'], 12.5), room('B', ['p_2'], 500)])).toBeNull();
    expect(roomParts(1_000, [room('A', ['p_1'], -5), room('B', ['p_2'], 500)])).toBeNull();
  });
});

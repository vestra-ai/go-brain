import { describe, expect, it } from 'vitest';
import { arrangementsFor, MAX_ARRANGEMENTS, shareRange, type Arrangement, type RoomType } from '../rooms.js';

// The Server's REV4 B5 (10 Oct): after a stay is picked, the ways the group can take its rooms, who shares with whom, and
// what each person pays. The rooms here are the test's own; their shapes are what ixigo's rooms call gives (a name, how
// many it sleeps, a price).
const villa: RoomType = { roomTypeId: 'rt_villa', label: 'Entire villa', sleeps: 8, priceMinor: 12_000_001 };
const deluxe: RoomType = { roomTypeId: 'rt_del', label: 'Deluxe room', sleeps: 2, priceMinor: 2_400_000 };
const standard: RoomType = { roomTypeId: 'rt_std', label: 'Standard room', sleeps: 2, priceMinor: 1_800_001 };
const family: RoomType = { roomTypeId: 'rt_fam', label: 'Family room', sleeps: 4, priceMinor: 4_000_000 };
const FOUR = ['p_rahul', 'p_priya', 'p_arjun', 'p_kabir'];
const FIVE = [...FOUR, 'p_meera'];

const inWords = (a: Arrangement[]) => a.map((x) => `${x.label}: ${x.rooms.map((r) => r.personIds.join('+')).join(' / ')}`);
const owed = (a: Arrangement) => Object.fromEntries(a.perPerson.map((p) => [p.personId, p.amountMinor]));

describe('the ways a group can take a stay\'s rooms', () => {
  it('puts everyone in an entire house, sharing its price to the paisa, and never offers a second house', () => {
    const got = arrangementsFor([villa], FIVE);
    expect(inWords(got)).toEqual(['Entire villa: p_rahul+p_priya+p_arjun+p_kabir+p_meera']);
    expect(got[0]!.totalMinor).toBe(12_000_001);
    // ₹1,20,000.01 five ways: the first takes the paisa over, and the shares add up to the price.
    expect(owed(got[0]!)).toEqual({ p_rahul: 2_400_001, p_priya: 2_400_000, p_arjun: 2_400_000, p_kabir: 2_400_000, p_meera: 2_400_000 });
  });

  it('offers the fewest rooms first, then one room more, cheapest first within each, every room with someone in it', () => {
    const got = arrangementsFor([deluxe, standard, family], FOUR);
    expect(inWords(got)).toEqual([
      'Family room: p_rahul+p_priya+p_arjun+p_kabir',
      '2 Standard room: p_rahul+p_priya / p_arjun+p_kabir',
      'Deluxe room + Standard room: p_rahul+p_priya / p_arjun+p_kabir',
      '2 Deluxe room: p_rahul+p_priya / p_arjun+p_kabir',
      'Family room + Standard room: p_rahul+p_priya+p_arjun / p_kabir',
      'Family room + Deluxe room: p_rahul+p_priya+p_arjun / p_kabir',
    ]);
    // Each pays their own room's share: a room's people split it, so a dearer room costs its people more.
    expect(owed(got[2]!)).toEqual({ p_rahul: 1_200_000, p_priya: 1_200_000, p_arjun: 900_001, p_kabir: 900_000 });
    expect(owed(got[4]!)['p_kabir']).toBe(1_800_001);
    for (const a of got) expect(a.perPerson.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(a.totalMinor);
  });

  it('keeps a pairing the group stated in one room, and the rest in the trip\'s order', () => {
    const got = arrangementsFor([deluxe, standard], FOUR, [['p_priya', 'p_kabir']]);
    expect(inWords(got).slice(0, 2)).toEqual([
      '2 Standard room: p_priya+p_kabir / p_rahul+p_arjun',
      'Deluxe room + Standard room: p_priya+p_kabir / p_rahul+p_arjun',
    ]);
    // A pairing no room has the beds for, or with someone not on the trip, is left to the order.
    expect(inWords(arrangementsFor([standard], FOUR, [['p_rahul', 'p_priya', 'p_arjun']])).slice(0, 1)).toEqual(['2 Standard room: p_rahul+p_priya / p_arjun+p_kabir']);
    expect(inWords(arrangementsFor([standard], FOUR, [['p_priya', 'p_nobody']])).slice(0, 1)).toEqual(['2 Standard room: p_rahul+p_priya / p_arjun+p_kabir']);
  });

  it('gives an odd one out a room of their own, at its whole price', () => {
    const got = arrangementsFor([standard, deluxe], FIVE);
    expect(inWords(got).slice(0, 2)).toEqual([
      '3 Standard room: p_rahul+p_priya / p_arjun+p_kabir / p_meera',
      'Deluxe room + 2 Standard room: p_rahul+p_priya / p_arjun+p_kabir / p_meera',
    ]);
    expect(owed(got[0]!)['p_meera']).toBe(1_800_001);
  });

  it('never offers a room with no number of beds, nothing for no one, and at most the card\'s ten', () => {
    expect(arrangementsFor([{ ...deluxe, sleeps: 0 }], FOUR)).toEqual([]);
    expect(arrangementsFor([deluxe], [])).toEqual([]);
    const thirty = Array.from({ length: 30 }, (_, i) => `p_${i}`);
    const big = arrangementsFor([deluxe, standard, family], thirty);
    expect(big).toHaveLength(MAX_ARRANGEMENTS);
    expect(big[0]!.rooms).toHaveLength(8);
  });

  it('names an arrangement the same way for the same rooms and people, so a tap finds it again', () => {
    const id = (people: string[]) => arrangementsFor([deluxe, standard], people)[0]!.arrangementId;
    expect(id(FOUR)).toBe(id(FOUR));
    expect(id(FOUR)).not.toBe(id(FIVE.slice(1)));
    expect(id(FOUR)).toMatch(/^ar_/);
  });
});

describe("a stay's price a person", () => {
  it('runs from the cheapest way the group can take its rooms to the dearest, for the whole stay', () => {
    expect(shareRange(arrangementsFor([deluxe, standard, family], FOUR), 4)).toEqual({ minMinor: 900_001, maxMinor: 1_600_000 });
    expect(shareRange([], 4)).toBeNull();
  });
});

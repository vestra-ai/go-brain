/**
 * How a group can split a stay's rooms (the Server's REV4 B5, 10 Oct): the room sets that fit everyone, the fewest rooms
 * first and then the cheapest, each with who shares with whom and what each person pays. A room's people share its price
 * equally; a pairing the group stated shares a room when one fits it. Pure: the rooms card, the price range on a stay
 * (B4) and the expense per room (B6) are all built from it.
 */
import { stableId } from './ids.js';

export interface RoomType {
  roomTypeId: string;
  label: string;
  /** How many the room sleeps, as ixigo says it: a room with no number is never offered (never guessed). */
  sleeps: number;
  /** The room for the whole stay, in minor units. */
  priceMinor: number;
}

export interface ArrangedRoom {
  roomTypeId: string;
  label: string;
  personIds: string[];
  priceMinor: number;
}

export interface Arrangement {
  arrangementId: string;
  /** The rooms in words: "2 Deluxe room + Standard room". */
  label: string;
  rooms: ArrangedRoom[];
  totalMinor: number;
  /** What each person pays, in the trip's order: their room's price over its people. */
  perPerson: Array<{ personId: string; amountMinor: number }>;
}

/** The most arrangements a card shows, and the most rooms one may have (the contract's 10 and 15). */
export const MAX_ARRANGEMENTS = 10;
export const MAX_ROOMS = 15;
/** The room types mixed: the cheapest a bed, so the sets stay few however many people and rooms. */
const MIXED_TYPES = 4;

/** Every set of k rooms from n types, a type repeated as often as it fits: index lists, each in order. */
function sets(n: number, k: number, from = 0): number[][] {
  if (k === 0) return [[]];
  const out: number[][] = [];
  for (let i = from; i < n; i++) for (const rest of sets(n, k - 1, i)) out.push([i, ...rest]);
  return out;
}

/** How many people each room takes: one each, then each next person in the room with the most beds free. */
function countsFor(rooms: RoomType[], people: number): number[] {
  const counts = rooms.map(() => 1);
  for (let left = people - rooms.length; left > 0; left--) {
    let best = 0;
    for (let i = 1; i < rooms.length; i++) if (rooms[i]!.sleeps - counts[i]! > rooms[best]!.sleeps - counts[best]!) best = i;
    counts[best] = counts[best]! + 1;
  }
  return counts;
}

/** A price shared by people, to the minor unit: the first ones take the remainder, so the shares add up to it. */
function shares(priceMinor: number, people: number): number[] {
  const each = Math.floor(priceMinor / people);
  return Array.from({ length: people }, (_, i) => each + (i < priceMinor - each * people ? 1 : 0));
}

/**
 * The ways people (in the trip's order) can take a stay's rooms, at most MAX_ARRANGEMENTS: the fewest rooms that sleep
 * everyone, and one room more, every room with someone in it and no room that sleeps everyone taken twice, cheapest first
 * within each count. together: pairings the
 * group stated ("Priya and Kabir share"), each put in one room when a room has the beds for it.
 */
export function arrangementsFor(types: RoomType[], people: string[], together: string[][] = []): Arrangement[] {
  const fit = types
    .filter((t) => Number.isInteger(t.sleeps) && t.sleeps >= 1 && t.priceMinor > 0)
    .sort((a, b) => a.priceMinor / a.sleeps - b.priceMinor / b.sleeps)
    .slice(0, MIXED_TYPES);
  const n = people.length;
  if (fit.length === 0 || n === 0) return [];
  const fewest = Math.ceil(n / Math.max(...fit.map((t) => t.sleeps)));
  const found: Array<{ rooms: RoomType[]; total: number }> = [];
  for (const k of [fewest, fewest + 1]) {
    if (k > n || k > MAX_ROOMS) continue;
    for (const set of sets(fit.length, k)) {
      const rooms = set.map((i) => fit[i]!).sort((a, b) => b.sleeps - a.sleeps || b.priceMinor - a.priceMinor);
      if (rooms.reduce((beds, r) => beds + r.sleeps, 0) < n) continue;
      // A room that sleeps everyone on its own (an entire house) is never taken twice.
      if (rooms.some((r, i) => r.sleeps >= n && rooms.indexOf(r) !== i)) continue;
      found.push({ rooms, total: rooms.reduce((sum, r) => sum + r.priceMinor, 0) });
    }
  }
  found.sort((a, b) => a.rooms.length - b.rooms.length || a.total - b.total);
  return found.slice(0, MAX_ARRANGEMENTS).map(({ rooms, total }) => arranged(rooms, total, people, together));
}

function arranged(rooms: RoomType[], total: number, people: string[], together: string[][]): Arrangement {
  const counts = countsFor(rooms, people.length);
  const placed: string[][] = rooms.map(() => []);
  const taken = new Set<string>();
  // The stated pairings first, the biggest first, each into the first room with the beds for it.
  for (const group of [...together].filter((g) => g.length >= 2 && g.every((p) => people.includes(p))).sort((a, b) => b.length - a.length)) {
    if (group.some((p) => taken.has(p))) continue;
    const room = placed.findIndex((inRoom, i) => counts[i]! - inRoom.length >= group.length);
    if (room < 0) continue;
    placed[room]!.push(...group);
    for (const p of group) taken.add(p);
  }
  // Everyone else in the trip's order, room by room.
  for (const p of people) {
    if (taken.has(p)) continue;
    placed[placed.findIndex((inRoom, i) => inRoom.length < counts[i]!)]!.push(p);
    taken.add(p);
  }
  const owed = new Map<string, number>();
  const arrangedRooms = rooms.map((r, i) => {
    const personIds = people.filter((p) => placed[i]!.includes(p));
    shares(r.priceMinor, personIds.length).forEach((amount, j) => owed.set(personIds[j]!, amount));
    return { roomTypeId: r.roomTypeId, label: r.label, personIds, priceMinor: r.priceMinor };
  });
  const byLabel = new Map<string, number>();
  for (const r of rooms) byLabel.set(r.label, (byLabel.get(r.label) ?? 0) + 1);
  return {
    arrangementId: stableId('ar', rooms.map((r) => r.roomTypeId).join(','), people.join(','), together.map((g) => g.join('+')).join(',')),
    label: [...byLabel].map(([label, count]) => (count === 1 ? label : `${count} ${label}`)).join(' + '),
    rooms: arrangedRooms,
    totalMinor: total,
    perPerson: people.map((p) => ({ personId: p, amountMinor: owed.get(p)! })),
  };
}

/**
 * A stay's price per person for the whole stay, from the cheapest to the dearest way the group can take its rooms (B4's
 * price_min_minor and price_max_minor); null with no arrangement.
 */
export function shareRange(arrangements: Arrangement[], people: number): { minMinor: number; maxMinor: number } | null {
  if (arrangements.length === 0 || people === 0) return null;
  const totals = arrangements.map((a) => a.totalMinor);
  return { minMinor: Math.round(Math.min(...totals) / people), maxMinor: Math.round(Math.max(...totals) / people) };
}

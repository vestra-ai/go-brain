/**
 * A stay's rooms as the group shared them (REV4 B5: the arrangement picked on the rooms card), for its expenses (B6): the
 * Server splits an expense equally between its people, so a stay with differently priced rooms is one expense a room,
 * split between that room's people, and everyone owes their own room's part.
 */
export interface Room {
  label: string;
  person_ids: string[];
  /** The room's price on the card, for the whole stay: only its weight against the other rooms. */
  price_minor: number;
}

/**
 * Each room's part of what was actually paid, in proportion to its price, in whole minor units; the last room takes what
 * the rounding leaves, so the parts add up to the payment exactly. Null when the rooms can't split it (no room, a room
 * nobody sleeps in, a price that is not a whole amount, or nothing to weigh by): the payment is then one expense.
 */
export function roomParts(paidMinor: number, rooms: readonly Room[]): Array<{ room: Room; amount_minor: number }> | null {
  if (rooms.length === 0 || rooms.some((r) => r.person_ids.length === 0 || !Number.isSafeInteger(r.price_minor) || r.price_minor < 0)) return null;
  const total = rooms.reduce((sum, r) => sum + BigInt(r.price_minor), 0n);
  if (total === 0n || !Number.isSafeInteger(paidMinor)) return null;
  let left = BigInt(paidMinor);
  return rooms.map((room, i) => {
    const part = i === rooms.length - 1 ? left : (BigInt(paidMinor) * BigInt(room.price_minor)) / total;
    left -= part;
    return { room, amount_minor: Number(part) };
  });
}

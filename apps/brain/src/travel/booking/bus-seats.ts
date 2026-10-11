/**
 * A bus's seats and stops as ixigo's seat layout lists them (POST /wap/GetSeatLayout, which a bus's "Select Seats" opens on
 * the results; p5's drill, 11 Oct: IntrCity SmartBus 22:35, Bengaluru to Goa), and the ones Go books for a person, chosen
 * here in code, never by the model (Keshav, 11 Oct: buses booked as flights are).
 *
 * Each seat is one line of the layout: "1LC, 1, 1, LB, Y, M, 4765, 0, 238.00, …", in the order of its `titles` (seat
 * number, row, column, type, available, ladies seat, fare in rupees, …). Rows run across the bus: the divider row is the
 * gangway, the outermost rows are by a window, and the rows beside the gangway are its aisle seats. A berth spans two
 * columns, so berths side by side share a column in neighbouring rows on one side of the gangway.
 */

export type Deck = 'lower' | 'upper';

export interface BusSeat {
  no: string;
  deck: Deck;
  row: number;
  col: number;
  /** ixigo's type: LB and UB are berths (sleeper), others seats. */
  type: string;
  sleeper: boolean;
  free: boolean;
  /** Kept for women travelling (ixigo's ladies seat). */
  ladies: boolean;
  /** The seat's fare, in paise. */
  fareMinor: number;
  window: boolean;
  aisle: boolean;
  /** Which side of the gangway: -1 or 1, 0 when the layout names no gangway. */
  side: number;
}

export interface BusPoint {
  id: string;
  /** Its name, with no phone number (a name often carries the operator's). */
  name: string;
  /** As the layout says it ("07:45 PM"). */
  time: string | null;
}

export interface BusLayout {
  operator: string;
  /** "2026-11-06 22:35". */
  departs: string | null;
  busType: string;
  seats: BusSeat[];
  /** The most seats one booking takes. */
  maxSeats: number;
  boarding: BusPoint[];
  dropping: BusPoint[];
}

const PHONE = /[\s-]*\+?\d[\d\s-]{7,}\d/g;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
};

function points(list: unknown): BusPoint[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((p): BusPoint[] => {
    const o = p as Record<string, unknown>;
    const id = str(o['placeId']) ?? (num(o['placeId']) !== null ? String(o['placeId']) : null);
    const name = str(o['placeName'])?.replace(PHONE, '').trim();
    return id && name ? [{ id, name, time: str(o['placeTime']) }] : [];
  });
}

/** The layout's seats, by its own column titles. A deck's window and aisle rows come from its rows and its gangway. */
function seatsOf(body: Record<string, unknown>): BusSeat[] {
  const titles = Array.isArray(body['titles']) ? (body['titles'] as unknown[]).map((t) => String(t).toLowerCase()) : [];
  const at = (title: string, fallback: number): number => {
    const i = titles.indexOf(title.toLowerCase());
    return i >= 0 ? i : fallback;
  };
  const col = {
    no: at('Seat Number', 0), row: at('Row ID', 1), col: at('Column ID', 2), type: at('Seat Type', 3), free: at('Availability', 4),
    ladies: at('Is Ladies Seat', 5), fare: at('Seat Fare', 6),
  };
  const list = (body['TotalSeatList'] ?? {}) as Record<string, unknown>;
  const out: BusSeat[] = [];
  for (const [deck, key] of [['lower', 'lowerdeck_seat_nos'], ['upper', 'upperdeck_seat_nos']] as const) {
    const lines = Array.isArray(list[key]) ? (list[key] as unknown[]) : [];
    const parsed = lines.flatMap((line) => {
      if (typeof line !== 'string') return [];
      const f = line.split(',').map((x) => x.trim());
      const no = f[col.no];
      const row = num(f[col.row]);
      const c = num(f[col.col]);
      const fare = num(f[col.fare]);
      if (!no || row === null || c === null || fare === null) return [];
      const type = (f[col.type] ?? '').toUpperCase();
      return [{ no, row, col: c, type, free: (f[col.free] ?? '').toUpperCase() === 'Y', ladies: (f[col.ladies] ?? '').toUpperCase() === 'F', fareMinor: Math.round(fare * 100) }];
    });
    const divider = num(body[`${deck}DividerRow`]);
    const rows = [...new Set(parsed.map((s) => s.row))].sort((a, b) => a - b);
    const first = rows[0];
    const last = rows.at(-1);
    for (const s of parsed) {
      const window = s.row === first || s.row === last;
      out.push({
        ...s,
        deck,
        sleeper: /B$/.test(s.type),
        window,
        // Beside the gangway, and not by a window (a 2+1 sleeper's single berth is by its window).
        aisle: !window && divider !== null && Math.abs(s.row - divider) === 1,
        side: divider !== null ? Math.sign(s.row - divider) : 0,
      });
    }
  }
  return out;
}

/** The layout as one booking needs it, or null when it isn't one (or is another bus's). */
export function busLayout(body: unknown): BusLayout | null {
  const o = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const seats = seatsOf(o);
  if (seats.length === 0) return null;
  return {
    operator: str(o['travelerAgentName']) ?? '',
    departs: str(o['startTimeDateFormat']),
    busType: str(o['busTypeName']) ?? '',
    seats,
    maxSeats: num(o['maxNumberOfSeats']) ?? 6,
    boarding: points(o['boardingPoints']),
    dropping: points(o['droppingPoints']),
  };
}

/** What the people booking asked for, in their words read by the model: a window or an aisle, a lower or upper berth. */
export interface SeatAsk {
  count: number;
  side?: 'window' | 'aisle';
  berth?: Deck;
  /** A woman travelling: a ladies seat is hers to take. */
  women?: boolean;
}

/** Seats that sit together: the same deck and column, in neighbouring rows on one side of the gangway. */
const together = (a: BusSeat, b: BusSeat): boolean => a.deck === b.deck && a.col === b.col && Math.abs(a.row - b.row) === 1 && a.side === b.side;

/**
 * The seats Go books: free, never one already taken by another booking of this trip on this bus, never a ladies seat
 * unless a woman travels; the ask's side and berth first, then the cheapest (the price the person picked was the bus's
 * lowest), then by a window, then nearer the front. Several people sit together when the bus has seats side by side.
 * Null when the bus hasn't that many free.
 */
export function chooseSeats(layout: BusLayout, ask: SeatAsk, taken: readonly string[] = []): BusSeat[] | null {
  const count = Math.max(1, Math.min(ask.count, layout.maxSeats));
  const free = layout.seats.filter((s) => s.free && !taken.includes(s.no) && (!s.ladies || ask.women === true));
  if (free.length < count) return null;
  const misses = (s: BusSeat): number =>
    (ask.berth && s.sleeper && s.deck !== ask.berth ? 2 : 0) + (ask.side === 'window' && !s.window ? 1 : 0) + (ask.side === 'aisle' && !s.aisle ? 1 : 0);
  const order = (a: BusSeat, b: BusSeat): number =>
    misses(a) - misses(b) || a.fareMinor - b.fareMinor || Number(b.window) - Number(a.window) || a.col - b.col || a.row - b.row;
  const ranked = [...free].sort(order);
  if (count === 1) return ranked.slice(0, 1);
  // Side by side first: the best seat that has a free neighbour, with it; then whatever is best.
  const chosen: BusSeat[] = [];
  for (const s of ranked) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => c.no === s.no)) continue;
    const mate = ranked.find((m) => m.no !== s.no && !chosen.some((c) => c.no === m.no) && together(s, m));
    if (mate && chosen.length + 2 <= count) chosen.push(s, mate);
  }
  for (const s of ranked) {
    if (chosen.length >= count) break;
    if (!chosen.some((c) => c.no === s.no)) chosen.push(s);
  }
  return chosen.slice(0, count);
}

/**
 * A boarding or dropping point: the first whose name holds one of the places the person is near (their area, their
 * stay's), else ixigo's first, which is the earliest boarding and the first stop.
 */
export function choosePoint(list: readonly BusPoint[], near: readonly string[] = []): BusPoint | null {
  const words = near.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3);
  return list.find((p) => words.some((w) => p.name.toLowerCase().includes(w))) ?? list[0] ?? null;
}

/** The seats and points in one clause, for the booking's live card ("seat 1UC, upper berth by the window, boarding at Chandapura 07:45 PM"). */
export function seatWords(seats: readonly BusSeat[], board: BusPoint | null, drop: BusPoint | null): string {
  const one = (s: BusSeat): string => {
    const where = s.window ? 'by the window' : s.aisle ? 'on the aisle' : '';
    const kind = s.sleeper ? `${s.deck} berth` : 'seat';
    return `${s.no} (${[kind, where].filter(Boolean).join(' ')})`;
  };
  const short = (p: BusPoint): string => p.name.split(/\s+-\s+/)[0]!.trim();
  const parts = [`${seats.length === 1 ? 'seat' : 'seats'} ${seats.map(one).join(', ')}`];
  if (board) parts.push(`boarding at ${short(board)}${board.time ? ` ${board.time}` : ''}`);
  if (drop) parts.push(`getting off at ${short(drop)}`);
  return parts.join(', ');
}

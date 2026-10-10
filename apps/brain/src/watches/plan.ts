// Which watches a trip needs right now, kept in step with the trip on every change (level-triggered).
// A watch's query is P4's StatusQuery as it is.
import type pg from 'pg';
import type * as C from '@go/contract';
import type { Trip } from '../door/methods.js';
import { picksOf, type PersonPick } from '../travel/picks.js';
import type { StatusQuery } from '../travel/travel.js';

export interface WatchPlan {
  watchId: string;
  tripId: string;
  query: StatusQuery;
  personIds: string[];
  label: string;
  startAt: Date;
  endsAt: Date;
}

const H = 3600_000;

/**
 * The flight number without its carrier code. The contract's Journey.number reads like "6E 2134", while P4's
 * StatusQuery takes the code and the number apart, so "6E 2134", "6E-2134" and "6E2134" all become "2134".
 */
export function flightNumber(number: string, carrierCode: string): string {
  const n = number.trim();
  const code = carrierCode.trim();
  if (!code || n.slice(0, code.length).toUpperCase() !== code.toUpperCase()) return n;
  const rest = n.slice(code.length).replace(/^[\s-]+/, '');
  return /^\d/.test(rest) ? rest : n;
}

/** A flight's watch, from a day before it leaves to an hour after it lands; null once it has, or with no number. */
function flightWatch(watchId: string, tripId: string, j: C.Journey | null | undefined, personIds: string[], t: number): WatchPlan | null {
  if (!j || !j.carrier_code || !j.number) return null;
  const depart = Date.parse(j.depart_at);
  const arrive = Date.parse(j.arrive_at);
  if (arrive + H <= t) return null;
  const number = flightNumber(j.number, j.carrier_code);
  return {
    watchId,
    tripId,
    query: { kind: 'flight', carrierCode: j.carrier_code, number, date: j.depart_at.slice(0, 10) },
    personIds,
    label: `${j.carrier_name ? `${j.carrier_name} ` : ''}${j.carrier_code} ${number}`,
    startAt: new Date(Math.max(t, depart - 24 * H)),
    endsAt: new Date(arrive + H),
  };
}

/**
 * The trip's watches: each confirmed booking's flight or train, and each person's own flight pick (travel/picks.ts),
 * booked through Go or on ixigo by themselves, for them alone. A pick a booking of theirs already watches, or of someone
 * no longer in the trip, adds none.
 */
export function planWatches(trip: Trip, now: Date, picks: PersonPick[] = []): WatchPlan[] {
  const out: WatchPlan[] = [];
  const t = now.getTime();
  for (const b of trip.bookings) {
    if (b.status !== 'confirmed') continue;
    const j = b.journey;
    if (b.kind === 'flight') {
      const w = flightWatch(`flight:${trip.trip_id}:${b.booking_id}`, trip.trip_id, j, b.for_person_ids, t);
      if (w) out.push(w);
    } else if (b.kind === 'train') {
      const leaves = Date.parse(j?.depart_at ?? b.starts_at ?? '');
      if (Number.isNaN(leaves) || leaves <= t) continue;
      out.push({
        watchId: `pnr:${trip.trip_id}:${b.booking_id}`,
        tripId: trip.trip_id,
        query: { kind: 'pnr', pnr: b.ref },
        personIds: b.for_person_ids,
        label: b.title,
        startAt: now,
        endsAt: new Date(leaves),
      });
    }
  }
  const people = new Set(trip.people.map((p) => p.person_id));
  for (const p of picks) {
    if (p.kind !== 'flight' || !people.has(p.personId)) continue;
    const w = flightWatch(`flight:${trip.trip_id}:pick:${p.personId}:${p.way}`, trip.trip_id, p.journey, [p.personId], t);
    if (!w || w.query.kind !== 'flight') continue;
    const q = w.query;
    const booked = out.some((o) => o.query.kind === 'flight' && o.query.carrierCode === q.carrierCode && o.query.number === q.number && o.query.date === q.date && o.personIds.includes(p.personId));
    if (!booked) out.push(w);
  }
  return out;
}

export async function syncWatches(pool: pg.Pool, trip: Trip, now: Date): Promise<void> {
  const plans = planWatches(trip, now, await picksOf(pool, trip.trip_id));
  for (const p of plans) {
    await pool.query(
      `insert into watches (watch_id, trip_id, kind, query, person_ids, label, next_check_at, ends_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (watch_id) do update set query = excluded.query, person_ids = excluded.person_ids,
         label = excluded.label, ends_at = excluded.ends_at, active = true,
         -- A new query (a rebooked flight, a new PNR) is a new thing to watch: its old reading, change and notice go.
         last_reading = case when watches.query = excluded.query then watches.last_reading end,
         last_change_key = case when watches.query = excluded.query then watches.last_change_key end,
         notice_card_id = case when watches.query = excluded.query then watches.notice_card_id end,
         errors = case when watches.query = excluded.query then watches.errors else 0 end,
         last_error = case when watches.query = excluded.query then watches.last_error end,
         next_check_at = case when watches.query = excluded.query then watches.next_check_at else excluded.next_check_at end`,
      [p.watchId, p.tripId, p.query.kind, JSON.stringify(p.query), p.personIds, p.label, p.startAt, p.endsAt],
    );
  }
  await pool.query(
    `update watches set active = false where trip_id = $1 and active and not (watch_id = any($2::text[]))`,
    [trip.trip_id, plans.map((p) => p.watchId)],
  );
}

export async function noteWatchNotice(pool: pg.Pool, watchId: string, cardId: string): Promise<void> {
  await pool.query(`update watches set notice_card_id = $2 where watch_id = $1`, [watchId, cardId]);
}

// Which watches a trip needs right now, kept in step with the trip on every change (level-triggered).
// A watch's query is P4's StatusQuery as it is.
import type pg from 'pg';
import type { Trip } from '../door/methods.js';
import type { StatusQuery } from './status.js';

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

export function planWatches(trip: Trip, now: Date): WatchPlan[] {
  const out: WatchPlan[] = [];
  const t = now.getTime();
  for (const b of trip.bookings) {
    if (b.status !== 'confirmed') continue;
    const j = b.journey;
    if (b.kind === 'flight') {
      if (!j || !j.carrier_code || !j.number) continue;
      const depart = Date.parse(j.depart_at);
      const arrive = Date.parse(j.arrive_at);
      if (arrive + H <= t) continue;
      const number = flightNumber(j.number, j.carrier_code);
      out.push({
        watchId: `flight:${trip.trip_id}:${b.booking_id}`,
        tripId: trip.trip_id,
        query: { kind: 'flight', carrierCode: j.carrier_code, number, date: j.depart_at.slice(0, 10) },
        personIds: b.for_person_ids,
        label: `${j.carrier_name ? `${j.carrier_name} ` : ''}${j.carrier_code} ${number}`,
        startAt: new Date(Math.max(t, depart - 24 * H)),
        endsAt: new Date(arrive + H),
      });
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
  return out;
}

export async function syncWatches(pool: pg.Pool, trip: Trip, now: Date): Promise<void> {
  const plans = planWatches(trip, now);
  for (const p of plans) {
    await pool.query(
      `insert into watches (watch_id, trip_id, kind, query, person_ids, label, next_check_at, ends_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (watch_id) do update set query = excluded.query, person_ids = excluded.person_ids,
         label = excluded.label, ends_at = excluded.ends_at, active = true`,
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

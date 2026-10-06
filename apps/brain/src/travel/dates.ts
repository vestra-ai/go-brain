/**
 * Today in a trip's own time zone, for the travel layer's one date rule: a search or a hold for a check-in or departure
 * before today never reaches a travel backend, and the refusal says which date to use instead.
 */
import type pg from 'pg';
import { isValidTz, localDay } from '../proactive/clock.js';

/** A trip's zone until it has its own (trips.tz has the same default). */
export const DEFAULT_TRIP_TZ = 'Asia/Kolkata';

/** Today (YYYY-MM-DD) in the trip's time zone; India's when there is no trip or its zone is unknown. */
export function tripToday(pool: pg.Pool, now: () => Date): (tripId: string | null) => Promise<string> {
  return async (tripId) => {
    const tz = tripId ? (await pool.query<{ tz: string }>('select tz from trips where trip_id = $1', [tripId])).rows[0]?.tz : undefined;
    return localDay(now(), tz && isValidTz(tz) ? tz : DEFAULT_TRIP_TZ);
  };
}

/** The same month and day as `day`, this year if that is today or later, else next year. */
export function nextOccurrence(day: string, today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = `${year}${day.slice(4)}`;
  return thisYear >= today ? thisYear : `${year + 1}${day.slice(4)}`;
}

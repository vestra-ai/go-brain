/**
 * A person's own flight booking as Go has it (flight_bookings), in the turns they speak in: under way, waiting for the
 * trip's ixigo login, stopped and why, its pay card up, or paid. Go's own state, never anyone's private words. The lead,
 * 11 Oct: Ankur's "?" 20 s after his booking stopped privately got "Ankur, what do you need?", the composer knowing
 * nothing of it.
 */
import type pg from 'pg';
import type { NowProvider } from '../../composer/context.js';
import type { Packs } from '../../trips/pack.js';
import { formatInr } from '../cards.js';

/** How long a booking stays in its person's turns after it last moved. */
export const BOOKING_NOW_MS = 3 * 60 * 60_000;
/** A booking that hasn't moved for this long while under way was cut off (a restart): its card is theirs to tap again. */
const STALLED_MS = 3 * 60_000;
const RUNNING = new Set(['fare', 'fare_type', 'coupon', 'travellers']);
const TAP_AGAIN = "their card is back: I'll take this tries again";

interface Row { person_id: string; title: string; state: string; why: string | null; total_minor: string | null; updated_at: Date }

/** The booking in words for the composer: where it is, and what they can do, as Go's state says it. */
export function bookingWords(r: Row, nowMs: number): string {
  const ago = Math.max(1, Math.round((nowMs - r.updated_at.getTime()) / 60_000));
  const when = `${ago} min ago`;
  const price = r.total_minor !== null ? formatInr(Number(r.total_minor)) : null;
  if (RUNNING.has(r.state)) {
    return nowMs - r.updated_at.getTime() < STALLED_MS
      ? `Go is booking ${r.title} for them on the trip's computer now; their pay card comes when it's ready.`
      : `Go's booking of ${r.title} was cut off (${when}); ${TAP_AGAIN}.`;
  }
  if (r.state === 'ready_to_pay') return `${r.title}: their pay card is up${price ? `, ${price}` : ''} (${when}); Pay on it pays.`;
  if (r.state === 'paid') return `${r.title} is paid (${when}).`;
  switch (r.why) {
    case 'login_needed':
      return `${r.title} waits for the trip's ixigo login (since ${when}): Go carries on by itself once it's in.`;
    case 'login_in':
      return `Go is booking ${r.title} for them now that the trip's ixigo login is in; their pay card comes when it's ready.`;
    case 'login_let_go':
      return `${r.title} stopped (${when}): the trip's ixigo login didn't come in; ${TAP_AGAIN}.`;
    case 'fare_moved':
      return `${r.title} stopped (${when}): its fare went up${price ? ` to ${price}` : ''}, and Go posted it at the new price for them to tap if they still want it.`;
    case 'travellers_not_read':
      return `${r.title} stopped (${when}): Go couldn't read their saved travellers on ixigo; ${TAP_AGAIN}.`;
    case 'no_saved_traveller':
      return `${r.title} stopped (${when}): they aren't a saved traveller on the trip's ixigo login yet; once they're added there, I'll take this again.`;
    case 'several_saved_travellers':
      return `${r.title} stopped (${when}): more than one saved traveller on the trip's ixigo login has their first name; once one is kept there, I'll take this again.`;
    default:
      return r.why?.startsWith('pay_')
        ? `${r.title} stopped at the payment (${when}): Go couldn't get it ready; ${TAP_AGAIN}.`
        : `${r.title} stopped (${when}): ixigo's page didn't answer on the trip's computer; ${TAP_AGAIN}.`;
  }
}

export function bookingsNow(d: { pool: pg.Pool; packs: Pick<Packs, 'get'>; now: () => Date }): NowProvider {
  return {
    name: 'bookings',
    order: 41,
    async render(tripId, wake) {
      const ids = new Set(wake.flatMap((i) => (i.kind === 'message' ? [(i.payload as { messageId?: string } | null)?.messageId ?? i.ref] : [])));
      if (ids.size === 0) return null;
      const pack = await d.packs.get(tripId);
      const speakers = [...new Set(pack.messages.flatMap((m) => (ids.has(m.message_id) && m.author.kind === 'person' ? [m.author.person_id] : [])))];
      if (speakers.length === 0) return null;
      const now = d.now();
      // Each speaker's latest booking that moved lately.
      const { rows } = await d.pool.query<Row>(
        `select distinct on (person_id) person_id, title, state, why, total_minor, updated_at from flight_bookings
         where trip_id = $1 and person_id = any($2) and updated_at > $3 order by person_id, updated_at desc`,
        [tripId, speakers, new Date(now.getTime() - BOOKING_NOW_MS)],
      );
      if (rows.length === 0) return null;
      const nameOf = (id: string) => pack.trip.people.find((p) => p.person_id === id)?.name ?? 'Someone';
      return [
        "Their own flight bookings, as Go has them now. When they ask, or seem lost (\"?\"), say where theirs is in a line, " +
          "as this says it: never that Go can't book flights.",
        ...rows.map((r) => `- ${nameOf(r.person_id)}: ${bookingWords(r, now.getTime())}`),
      ].join('\n');
    },
  };
}

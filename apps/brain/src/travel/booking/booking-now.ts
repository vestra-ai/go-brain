/**
 * The trip's flight bookings as Go has them (flight_bookings), "right now": under way, waiting for the trip's ixigo login,
 * stopped and why, the pay card up, or paid. Go's own state in its own words, never a private post's (screen.ts blanks
 * those for the group's turns, so without this no turn knew a booking step was up). The lead, 11 Oct: Ankur's "?" 20 s
 * after his booking stopped privately got "Ankur, what do you need?"; p2's prod audit, #16. Whoever spoke comes first.
 */
import type pg from 'pg';
import type { NowProvider } from '../../composer/context.js';
import type { Packs } from '../../trips/pack.js';
import { formatInr } from '../cards.js';
import { spokenFirstName } from './travellers.js';

/** How long a booking stays "right now" after it last moved. */
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
  if (r.state === 'ready_to_pay') return `${r.title}: their pay card is up${price ? `, ${price}` : ''} (${when}); Pay with ixigo money on it pays.`;
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
    case 'gender_needed':
      return `${r.title} waits for them to tap Male or Female on Go's card (since ${when}), for ixigo's traveller form: Go carries on by itself then.`;
    case 'gender_in':
      return `Go is booking ${r.title} for them now that they answered its card; their pay card comes when it's ready.`;
    case 'traveller_name_needed':
      return `${r.title} stopped (${when}): ixigo's traveller form needs their last name as on their ID, and their name in the trip is one word; once their travel details are in Go, I'll take this again.`;
    case 'traveller_not_filled':
      return `${r.title} stopped (${when}): Go couldn't fill their traveller details on ixigo's form; ${TAP_AGAIN}.`;
    case 'details_needed':
      return `${r.title} waits for them to add their travel details in Go (their age and IRCTC user ID), from the card Go sent (since ${when}): Go carries on by itself then.`;
    case 'details_in':
      return `Go is booking ${r.title} for them now that their travel details are in; their pay card comes when it's ready.`;
    case 'details_let_go':
      return `${r.title} stopped (${when}): their travel details didn't come in; ${TAP_AGAIN}.`;
    case 'seats_not_read':
      return `${r.title} stopped (${when}): Go couldn't read its seats on ixigo; ${TAP_AGAIN}.`;
    case 'passengers_not_filled':
      return `${r.title} stopped (${when}): Go couldn't fill their passenger details on ixigo's form; ${TAP_AGAIN}.`;
    case 'international_traveller':
      return `${r.title} stopped (${when}): an international ticket needs passport details on ixigo's form, which Go doesn't fill yet.`;
    default:
      return r.why?.startsWith('pay_')
        ? `${r.title} stopped at the payment (${when}): Go couldn't get it ready; ${TAP_AGAIN}.`
        : `${r.title} stopped (${when}): ixigo's page didn't answer on the trip's computer; ${TAP_AGAIN}.`;
  }
}

export function bookingsNow(d: { pool: pg.Pool; packs: Pick<Packs, 'get'>; now: () => Date }): NowProvider {
  return {
    name: 'bookings',
    // Right after the booking rules and the picks (book-flight.ts bookingNow, 38).
    order: 39,
    async render(tripId, wake) {
      const now = d.now();
      // Each traveller's latest booking that moved lately.
      const { rows } = await d.pool.query<Row>(
        `select distinct on (person_id) person_id, title, state, why, total_minor, updated_at from flight_bookings
         where trip_id = $1 and updated_at > $2 order by person_id, updated_at desc`,
        [tripId, new Date(now.getTime() - BOOKING_NOW_MS)],
      );
      if (rows.length === 0) return null;
      const pack = await d.packs.get(tripId);
      const ids = new Set(wake.flatMap((i) => (i.kind === 'message' ? [(i.payload as { messageId?: string } | null)?.messageId ?? i.ref] : [])));
      const spoke = new Set(pack.messages.flatMap((m) => (ids.has(m.message_id) && m.author.kind === 'person' ? [m.author.person_id] : [])));
      const nameOf = (id: string) => spokenFirstName(pack.trip.people.find((p) => p.person_id === id)?.name ?? 'Someone');
      const ordered = [...rows].sort((a, b) => Number(spoke.has(b.person_id)) - Number(spoke.has(a.person_id)) || a.person_id.localeCompare(b.person_id));
      return [
        'Right now, the trip\'s bookings (flights and trains) as Go has them (each one is its traveller\'s: when they ask, or seem lost ("?"), ' +
          "say where theirs is in a line, as this says it, never that Go can't book flights; bring up nobody's unasked):",
        ...ordered.map((r) => `- ${nameOf(r.person_id)}${spoke.has(r.person_id) ? ' (spoke now)' : ''}: ${bookingWords(r, now.getTime())}`),
      ].join('\n');
    },
  };
}

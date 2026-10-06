// Timers: moments worth a nudge that the clock alone brings (a vote about to close, free cancellation
// ending, travel day, settle-up, a payer who has not answered). Planned from the trip as it is now,
// re-planned on every trip change, and checked again against the trip when they come due.
import type { Trip } from '../door/methods.js';
import type { TripPack } from '../trips/pack.js';
import { addDays, zonedTime } from './clock.js';
import type { Action, Candidate } from './policy.js';
import type { ProactiveStore } from './store.js';

const H = 3600_000;
export const VOTE_REMINDER_BEFORE_MS = 2 * H;
export const FREE_CANCEL_BEFORE_MS = 24 * H;
export const PAYER_WAIT_MS = 24 * H;
export const TRAVEL_DAY_HOUR = 19;
export const SETTLE_UP_HOUR = 11;

export function nonVoters(trip: Trip, decisionId: string): string[] {
  const d = trip.decisions.find((x) => x.decision_id === decisionId);
  if (!d || d.anonymous) return [];
  const voted = new Set((d.votes ?? []).map((v) => v.person_id));
  return trip.people.filter((p) => !voted.has(p.person_id)).map((p) => p.person_id);
}

/** Confirmed bookings that fall outside the trip's dates (a day of slack each side for time zones). */
export function dateClashes(trip: Trip): Array<{ booking_id: string; title: string; starts_at: string; ends_at: string | null }> {
  const dates = trip.dates;
  if (!dates) return [];
  const out: Array<{ booking_id: string; title: string; starts_at: string; ends_at: string | null }> = [];
  for (const b of trip.bookings) {
    if (b.status !== 'confirmed' || !b.starts_at) continue;
    const startDay = b.starts_at.slice(0, 10);
    const endDay = (b.ends_at ?? b.starts_at).slice(0, 10);
    if (startDay < addDays(dates.start, -1) || endDay > addDays(dates.end, 1)) {
      out.push({ booking_id: b.booking_id, title: b.title, starts_at: b.starts_at, ends_at: b.ends_at ?? null });
    }
  }
  return out;
}

export function planTimers(trip: Trip, tz: string, now: Date): Candidate[] {
  const t = now.getTime();
  const notBefore = (at: number): Date => new Date(Math.max(at, t));
  const inTrip = new Set(trip.people.map((p) => p.person_id));
  const out: Candidate[] = [];
  const timer = (o: {
    key: string;
    topic: string;
    dueAt: Date;
    expiresAt: Date | null;
    importance: number;
    urgency: number;
    useful: Action[];
    personIds: string[];
    facts: Record<string, unknown>;
  }): Candidate => ({
    tripId: trip.trip_id,
    dedupeKey: o.key,
    source: 'timer',
    topic: o.topic,
    dueAt: o.dueAt,
    expiresAt: o.expiresAt,
    importance: o.importance,
    confidence: 1,
    urgency: o.urgency,
    useful: o.useful,
    personIds: o.personIds,
    facts: o.facts,
    simulated: false,
    small: false,
  });

  for (const d of trip.decisions) {
    if (d.status === 'open' && d.closes_at && d.voted < d.of) {
      const closes = Date.parse(d.closes_at);
      if (closes > t) {
        out.push(timer({
          key: `vote_closing:${d.decision_id}:${d.closes_at}`,
          topic: 'vote_closing',
          dueAt: notBefore(closes - VOTE_REMINDER_BEFORE_MS),
          expiresAt: new Date(closes),
          importance: 0.6,
          urgency: 0.8,
          useful: d.anonymous ? ['message'] : ['pin'],
          personIds: d.anonymous ? [] : nonVoters(trip, d.decision_id),
          facts: { decision_id: d.decision_id, closes_at: d.closes_at },
        }));
      }
    }
    const m = d.mandate;
    if (m && m.confirmed_at == null && m.declined_at == null && inTrip.has(m.payer_person_id)) {
      const due = Date.parse(m.set_at) + PAYER_WAIT_MS;
      const expires = due + 48 * H;
      if (expires > t) {
        out.push(timer({
          key: `payer_waiting:${d.decision_id}:${m.set_at}`,
          topic: 'payer_waiting',
          dueAt: notBefore(due),
          expiresAt: new Date(expires),
          importance: 0.6,
          urgency: 0.7,
          useful: ['pin'],
          personIds: [m.payer_person_id],
          facts: { decision_id: d.decision_id, set_at: m.set_at },
        }));
      }
    }
  }

  for (const b of trip.bookings) {
    if (b.status !== 'confirmed' || !b.refundable_until) continue;
    const until = Date.parse(b.refundable_until);
    if (until <= t) continue;
    out.push(timer({
      key: `free_cancel:${b.booking_id}:${b.refundable_until}`,
      topic: 'free_cancel',
      dueAt: notBefore(until - FREE_CANCEL_BEFORE_MS),
      expiresAt: new Date(until),
      importance: 0.7,
      urgency: 0.7,
      useful: ['pin'],
      personIds: inTrip.has(b.payer_person_id) ? [b.payer_person_id] : [],
      facts: { booking_id: b.booking_id, refundable_until: b.refundable_until },
    }));
  }

  if (trip.dates && trip.status !== 'over') {
    const due = zonedTime(addDays(trip.dates.start, -1), TRAVEL_DAY_HOUR, 0, tz);
    const expires = due.getTime() + 5 * H;
    if (expires > t) {
      out.push(timer({
        key: `travel_day:${trip.dates.start}`,
        topic: 'travel_day',
        dueAt: notBefore(due.getTime()),
        expiresAt: new Date(expires),
        importance: 0.6,
        urgency: 0.8,
        useful: ['message'],
        personIds: [],
        facts: { start: trip.dates.start },
      }));
    }
  }

  if (trip.dates) {
    const due = zonedTime(addDays(trip.dates.end, 1), SETTLE_UP_HOUR, 0, tz);
    const expires = due.getTime() + 72 * H;
    if (expires > t) {
      out.push(timer({
        key: `settle_up:${trip.dates.end}`,
        topic: 'settle_up',
        dueAt: notBefore(due.getTime()),
        expiresAt: new Date(expires),
        importance: 0.6,
        urgency: 0.8,
        useful: ['message'],
        personIds: [],
        facts: { end: trip.dates.end },
      }));
    }
  }
  return out;
}

/** Level-triggered: whatever the trip looks like now decides which timers wait. Safe to repeat. */
export async function replanTimers(store: ProactiveStore, trip: Trip, tz: string, now: Date): Promise<number> {
  const plans = planTimers(trip, tz, now);
  for (const c of plans) await store.plan(c);
  await store.dropUnplanned(trip.trip_id, plans.map((c) => c.dedupeKey), now);
  return plans.length;
}

export type Check = { ok: true; personIds: string[] } | { ok: false };

/**
 * Checked when a candidate comes due: is what Go noticed still true? Also refreshes who it concerns.
 * `watchKeys` is each watch's newest change key (watches.last_change_key), for the trip's watch nudges.
 */
export function stillTrue(c: Candidate, pack: TripPack, watchKeys: ReadonlyMap<string, string | null> = new Map()): Check {
  const trip = pack.trip;
  const f = c.facts;
  const yes = (personIds: string[] = c.personIds): Check => ({ ok: true, personIds });
  const no: Check = { ok: false };
  switch (c.topic) {
    case 'vote_closing': {
      const d = trip.decisions.find((x) => x.decision_id === f.decision_id);
      if (!d || d.status !== 'open' || d.closes_at !== f.closes_at || d.voted >= d.of) return no;
      return yes(d.anonymous ? [] : nonVoters(trip, d.decision_id));
    }
    case 'payer_waiting': {
      const m = trip.decisions.find((x) => x.decision_id === f.decision_id)?.mandate;
      if (!m || m.set_at !== f.set_at || m.confirmed_at != null || m.declined_at != null) return no;
      return yes();
    }
    case 'free_cancel': {
      const b = trip.bookings.find((x) => x.booking_id === f.booking_id);
      return b && b.status === 'confirmed' && b.refundable_until === f.refundable_until ? yes() : no;
    }
    case 'travel_day':
      return trip.dates?.start === f.start && trip.status !== 'over' ? yes() : no;
    case 'settle_up':
      return trip.dates?.end === f.end && trip.money.transfers.length > 0 ? yes() : no;
    case 'chat': {
      const m = pack.messages.find((x) => x.message_id === f.message_id);
      return m && !m.deleted ? yes() : no;
    }
    case 'dates_clash':
      return dateClashes(trip).some((x) => x.booking_id === f.booking_id) ? yes() : no;
    case 'flight_status':
    case 'pnr_status': {
      // The demo's simulated delay has no watch behind it. A real watch's nudge holds while its booking is still
      // confirmed and no later reading of the watch has replaced this change (watch ids are <kind>:<trip>:<booking>).
      if (c.simulated || typeof f.watchId !== 'string') return yes();
      const at = f.watchId.indexOf(`:${c.tripId}:`);
      const bookingId = at < 0 ? '' : f.watchId.slice(at + c.tripId.length + 2);
      const b = trip.bookings.find((x) => x.booking_id === bookingId);
      if (!b || b.status !== 'confirmed') return no;
      return watchKeys.get(f.watchId) === c.dedupeKey ? yes() : no;
    }
    default:
      return yes();
  }
}

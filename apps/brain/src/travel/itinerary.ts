import { createHash } from 'node:crypto';
import type * as C from '@go/contract';
import { z } from 'zod';
import type { QuickTool } from '../composer/tools.js';
import type { TripEvent } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { TripPack } from '../trips/pack.js';
import { clip } from './cards.js';
import { stableId } from './ids.js';
import type { ResultsStore } from './results.js';

/**
 * The trip's itinerary from its dates and bookings (prod, 11 Oct, Keshav: "itinerary is not working"). The App's
 * Itinerary tab shows the trip's stored itinerary alone, and Go never wrote it: every trip said "No plan yet", even with
 * its stay and flights booked. Go writes it with update_trip, which replaces the whole list: one day per date, the stay's
 * check-in and check-out, each journey on its day. Every item people added (no booking_id) is kept as it is; only the
 * items bookings make are replaced, with ids from their booking, so writing it again changes nothing.
 */

type Trip = Pick<C.TripSnapshot, 'dates' | 'bookings' | 'itinerary' | 'destination' | 'people'> & Partial<Pick<C.TripSnapshot, 'decisions'>>;
/** A stay's place with its coordinates, by booking id, from what the search found of it (stayPlaces). */
export type Places = ReadonlyMap<string, C.Place>;
const NO_PLACES: Places = new Map();
export type Day = C.TripSnapshot['itinerary'][number];
type Item = Day['items'][number];

const MAX_DAYS = 30;
const MAX_ITEMS = 20;
const HOME_TZ = 'Asia/Kolkata';
/** The day titles Go gives; any other title is a person's, and stays. */
const GO_TITLE = /^(Arrive|Head home|Day \d+)$/;
const VERB: Record<C.Journey['mode'], string> = { flight: 'Fly', train: 'Train', bus: 'Bus', cab: 'Cab' };
const CATEGORY: Record<C.Booking['kind'], Item['category']> = {
  stay: 'stay', flight: 'getting_around', train: 'getting_around', bus: 'getting_around', cab: 'getting_around',
  table: 'food', activity: 'activities', other: 'other',
};

/** A moment as its date and "HH:MM" where the trip is. */
function local(iso: string | null | undefined, tz: string): { date: string; time: string } | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const parts = (zone: string) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(at))
        .map((p) => [p.type, p.value]),
    );
  let p: Record<string, string>;
  try {
    p = parts(tz);
  } catch {
    p = parts(HOME_TZ);
  }
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Every date from start to end, both in. */
function datesFrom(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`) && out.length < MAX_DAYS; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** An item id from its booking, within the contract's 64 characters. */
function itemId(bookingId: string, part: string): string {
  const id = `${bookingId}_${part}`;
  return id.length <= 64 ? id : `bk_${createHash('sha256').update(id).digest('hex').slice(0, 40)}_${part}`;
}

/** A journey's line: "Fly DEL → GOI · 6E 2134". */
function journeyTitle(j: C.Journey): string {
  const end = (e: C.Journey['origin']) => e.code || e.name;
  const number = j.number ? (j.carrier_code && !j.number.startsWith(j.carrier_code) ? `${j.carrier_code} ${j.number}` : j.number) : j.carrier_name;
  return clip(`${VERB[j.mode]} ${end(j.origin)} → ${end(j.destination)}${number ? ` · ${number}` : ''}`, 120);
}

/**
 * A place the App's map can pin: its name, its address when known, and its coordinates, which must both be there. Never
 * made up: from the booking or the search that found it, else none.
 */
function pinned(
  p: { name?: string | null | undefined; address?: string | null | undefined; lat?: number | null | undefined; lng?: number | null | undefined } | null | undefined,
  name: string,
): C.Place | null {
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
  return { name: clip(p.name || name, 120), ...(p.address ? { address: clip(p.address, 200) } : {}), lat: p.lat, lng: p.lng };
}

/**
 * Where each booked stay is when its booking has no coordinates: the voted option's place, as the search that found it
 * kept it (the same data the option's details map shows). None found: no pin, never a guess.
 */
export function stayPlaces(results: Pick<ResultsStore, 'optionOf'>) {
  return async (trip: Trip): Promise<Places> => {
    const out = new Map<string, C.Place>();
    for (const b of trip.bookings) {
      if (b.kind !== 'stay' || b.status !== 'confirmed' || pinned(b.place, b.title) || !b.decision_id) continue;
      const vote = trip.decisions?.find((x) => x.decision_id === b.decision_id);
      const index = vote?.mandate?.choice_index ?? vote?.result_index;
      const ref = index === null || index === undefined ? null : vote?.options[index]?.option_ref;
      if (!ref) continue;
      const option = await results.optionOf(ref).catch(() => null);
      const where = pinned(option?.place, b.place?.name ?? b.title);
      if (where) out.set(b.booking_id, where);
    }
    return out;
  };
}

/** The items the trip's confirmed bookings make, each with its date. */
function bookedItems(trip: Trip, tz: string, places: Places = NO_PLACES): Array<{ date: string; item: Item }> {
  const out: Array<{ date: string; item: Item }> = [];
  const everyone = new Set(trip.people.map((p) => p.person_id));
  const add = (date: string | undefined, item: Item) => {
    if (date) out.push({ date, item });
  };
  for (const b of trip.bookings) {
    if (b.status !== 'confirmed') continue;
    const base = { booking_id: b.booking_id, status: 'booked' as const, category: CATEGORY[b.kind] };
    // A time only when the booking has one: midnight is a date with no time.
    const timed = (at: { date: string; time: string } | null) => (at && at.time !== '00:00' ? { time: at.time } : {});
    if (b.kind === 'stay') {
      const name = b.place?.name ?? b.title;
      const inAt = local(b.starts_at, tz);
      const outAt = local(b.ends_at, tz);
      // The map's pin: the booking's own place with coordinates, else what the search found of it.
      const where = pinned(b.place, name) ?? places.get(b.booking_id) ?? null;
      const at = where ? { place: where } : {};
      add(inAt?.date ?? trip.dates?.start, { item_id: itemId(b.booking_id, 'in'), ...timed(inAt), title: clip(`Check in at ${name}`, 120), ...at, ...base, audience: 'group' });
      add(outAt?.date ?? trip.dates?.end, { item_id: itemId(b.booking_id, 'out'), ...timed(outAt), title: clip(`Check out of ${name}`, 120), ...at, ...base, audience: 'group' });
      continue;
    }
    const who = b.for_person_ids;
    const forEveryone = who.length >= everyone.size && who.every((p) => everyone.has(p));
    const journeys = [b.journey, b.return_journey].filter((j): j is C.Journey => !!j);
    if (journeys.length) {
      journeys.forEach((j, i) => {
        const at = local(j.depart_at, tz);
        // Where it lands, by name: a journey carries no coordinates, so no pin is made up.
        add(at?.date, {
          item_id: itemId(b.booking_id, i === 0 ? 'go' : 'back'), ...timed(at), title: journeyTitle(j), place: { name: clip(j.destination.name, 120) },
          ...base, person_ids: who, audience: 'shared',
        });
      });
      continue;
    }
    const at = local(b.starts_at, tz);
    add(at?.date, {
      item_id: itemId(b.booking_id, 'at'), ...timed(at), title: clip(b.title, 120), ...base,
      ...(forEveryone ? { audience: 'group' as const } : { person_ids: who, audience: 'shared' as const }),
    });
  }
  return out;
}

const byTime = (a: Item, b: Item): number => (a.time ?? '99:99').localeCompare(b.time ?? '99:99');

/**
 * The itinerary the trip's dates and bookings make, every item people added kept as it is. Null when there is nothing
 * to write: no booking makes an item and none is stored.
 */
export function itineraryOf(trip: Trip, places: Places = NO_PLACES): Day[] | null {
  const tz = trip.destination?.timezone || HOME_TZ;
  if (!bookedItems(trip, tz).length && !(trip.itinerary ?? []).some((d) => d.items.some((i) => i.booking_id))) return null;
  return daysFor(trip, trip.itinerary ?? [], places);
}

/** The days from the trip's dates and bookings, over these stored days: their items with no booking kept as they are. */
function daysFor(trip: Trip, stored: readonly Day[], places: Places = NO_PLACES): Day[] {
  const tz = trip.destination?.timezone || HOME_TZ;
  const booked = bookedItems(trip, tz, places);
  const all = booked.map((b) => b.date).sort();
  const range = trip.dates ? datesFrom(trip.dates.start, trip.dates.end) : all.length ? datesFrom(all[0]!, all[all.length - 1]!) : [];
  const theirs = new Map<string, Item[]>();
  for (const day of stored) theirs.set(day.date, day.items.filter((i) => !i.booking_id));
  const storedDay = new Map(stored.map((d) => [d.date, d]));
  const dates = [...new Set([...range, ...booked.map((b) => b.date), ...[...theirs].filter(([, items]) => items.length).map(([date]) => date)])]
    .sort()
    .slice(0, MAX_DAYS);

  return dates.map((date) => {
    const at = range.indexOf(date);
    const goTitle = at < 0 ? null : at === 0 ? 'Arrive' : at === range.length - 1 ? 'Head home' : `Day ${at + 1}`;
    const kept = storedDay.get(date);
    const title = kept?.title && !GO_TITLE.test(kept.title) ? kept.title : goTitle;
    const ours = booked.filter((b) => b.date === date).map((b) => b.item);
    // Booking items always fit; people's fill the rest of the day's 20.
    const people = (theirs.get(date) ?? []).slice(0, Math.max(0, MAX_ITEMS - ours.length));
    return {
      date,
      ...(title ? { title } : {}),
      ...(kept?.image_url ? { image_url: kept.image_url } : {}),
      items: [...ours, ...people].sort(byTime).slice(0, MAX_ITEMS),
    };
  });
}

/** The same itinerary, whatever the key order or empty fields: the Server stores what Go sends as sent. */
export function sameItinerary(a: readonly Day[], b: readonly Day[]): boolean {
  return canon(a) === canon(b);
}

function canon(v: unknown): string {
  const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([, val]) => val !== null && val !== undefined)
          .sort(([k1], [k2]) => k1.localeCompare(k2))
          .map(([k, val]) => [k, strip(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(strip(v));
}

/** What plan_days takes: the days to plan, each with what to do, eat or see. */
const PlanArgs = z.object({
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
        title: z.string().min(1).max(80).optional().describe('A name for the day, e.g. "North Goa beaches"'),
        items: z
          .array(
            z.object({
              time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('"HH:MM" where the trip is, when known'),
              title: z.string().min(1).max(120),
              category: z.enum(['food', 'activities', 'getting_around', 'stay', 'other']),
              note: z.string().max(200).optional(),
              person_ids: z.array(z.string()).max(30).optional().describe('Only when it is for some of the group, not all'),
              place: z
                .object({ name: z.string().min(1).max(120), address: z.string().max(200).optional() })
                .optional()
                .describe('Where it is, by name (and address when known); never coordinates'),
            }),
          )
          .max(15),
      }),
    )
    .min(1)
    .max(14),
});
type Plan = z.infer<typeof PlanArgs>;

/**
 * The itinerary with these days planned: each day named has its planned items (no booking) replaced by the plan's and
 * its title set when given; booked items are made from the bookings as always, and every other day stays as it is.
 */
export function withPlan(trip: Trip, plan: Plan, places: Places = NO_PLACES): Day[] {
  const people = new Set(trip.people.map((p) => p.person_id));
  const stored = trip.itinerary ?? [];
  const planned = new Map(plan.days.map((day) => [day.date, day]));
  const dates = [...new Set([...stored.map((day) => day.date), ...planned.keys()])].sort();
  const next = dates.map((date): Day => {
    const kept = stored.find((day) => day.date === date);
    const p = planned.get(date);
    if (!p) return kept!;
    const items: Item[] = p.items.map((it) => {
      const who = (it.person_ids ?? []).filter((id) => people.has(id));
      return {
        item_id: stableId('it', date, it.title, it.time ?? ''),
        ...(it.time ? { time: it.time } : {}),
        title: clip(it.title, 120),
        category: it.category,
        status: 'planned',
        ...(it.note ? { note: it.note } : {}),
        // The model names a place; it never gives coordinates, so it is never a made-up pin.
        ...(it.place ? { place: { name: clip(it.place.name, 120), ...(it.place.address ? { address: clip(it.place.address, 200) } : {}) } } : {}),
        ...(who.length ? { person_ids: who, audience: 'shared' as const } : {}),
      };
    });
    const title = p.title ?? kept?.title;
    return { date, ...(title ? { title } : {}), ...(kept?.image_url ? { image_url: kept.image_url } : {}), items };
  });
  return daysFor(trip, next, places);
}

/** The model's way to fill the days: what the chat agreed or asked for, merged with what is booked. No vote. */
export function planDaysTool(placesFor: (trip: Trip) => Promise<Places> = async () => NO_PLACES): QuickTool<Plan> {
  return {
    name: 'plan_days',
    description:
      "Puts a plan for the days you name on the trip's Itinerary tab: what to do, eat or see, with times when known. Each day " +
      'you name has its planned items replaced by these; booked items (the stay, flights) stay as they are, and days you do not ' +
      'name are untouched. Use it when someone asks to plan the days or the chat agrees a plan. No vote.',
    input: PlanArgs,
    async run(a, ctx) {
      const next = withPlan(ctx.pack.trip, a, await placesFor(ctx.pack.trip).catch(() => NO_PLACES));
      if (sameItinerary(next, ctx.pack.trip.itinerary ?? [])) return { ok: true, note: 'The plan is already that.' };
      await ctx.link.request('update_trip', { request_id: stableId('go_plan_days', ctx.tripId, ctx.turnId, canon(next)), trip_id: ctx.tripId, itinerary: next });
      return { ok: true, days: a.days.map((day) => day.date), note: "The plan is on the trip's Itinerary tab. Say so in one short line." };
    },
  };
}

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/**
 * Keeps each trip's itinerary in line with its bookings and dates: a booking added, changed or cancelled (whoever made
 * it: the vault's payment, the Server's, a flight or bus ticket), the dates moved, and a trip's first event after Go
 * starts (trips booked before this wrote nothing). Go's own itinerary write comes back as trip.updated with only
 * "itinerary" changed, which wakes nothing here. One rewrite at a time per trip; a change during one runs it again.
 */
export function createItinerary(d: {
  link: Pick<ServerLink, 'request'>;
  packs: { get(tripId: string): Promise<TripPack> };
  log: Log;
  /** Where each booked stay is when its booking has no coordinates (stayPlaces). Absent: the bookings' own only. */
  placesFor?: (trip: Trip) => Promise<Places>;
}) {
  const seen = new Set<string>();
  const runs = new Map<string, { again: boolean; done: Promise<void> }>();

  async function rewrite(tripId: string): Promise<void> {
    const pack = await d.packs.get(tripId);
    const next = itineraryOf(pack.trip, d.placesFor ? await d.placesFor(pack.trip).catch(() => NO_PLACES) : NO_PLACES);
    if (!next || sameItinerary(next, pack.trip.itinerary ?? [])) return;
    await d.link.request('update_trip', { request_id: stableId('go_itinerary', tripId, canon(next)), trip_id: tripId, itinerary: next });
    const booked = next.reduce((n, day) => n + day.items.filter((i) => i.booking_id).length, 0);
    d.log.info({ trip: tripId, days: next.length, booked }, 'itinerary: wrote the days from the bookings');
  }

  function soon(tripId: string): void {
    const run = runs.get(tripId);
    if (run) {
      run.again = true;
      return;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      do {
        entry.again = false;
        try {
          await rewrite(tripId);
        } catch (err) {
          d.log.warn({ trip: tripId, err: err instanceof Error ? err.message : String(err) }, 'itinerary: the rewrite failed; the next booking or date change tries again');
        }
      } while (entry.again);
      runs.delete(tripId);
    })();
    runs.set(tripId, entry);
  }

  return {
    onEvent(ev: TripEvent): void {
      const first = !seen.has(ev.trip_id);
      seen.add(ev.trip_id);
      if (first || ev.type === 'booking.changed' || (ev.type === 'trip.updated' && ev.data.changed.includes('dates'))) soon(ev.trip_id);
    },
    /** Waits for every rewrite under way (tests, stop). */
    async settled(): Promise<void> {
      while (runs.size) await Promise.all([...runs.values()].map((r) => r.done));
    },
  };
}

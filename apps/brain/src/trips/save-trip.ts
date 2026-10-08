/**
 * The one way Go changes the trip: the composer's update_trip tool, and the notes pass when an agreed line fixes the
 * trip's dates or place, both go through here. The trip is the Server's: Go writes the change with update_trip (only the
 * fields sent change) and the Server sends it back as trip.updated. A stay or place a vote decided is saved from the
 * winning option's own data, and a different one is refused; dates are checked against today where the trip is.
 */
import type { Place } from '@go/contract';
import type { Pool } from 'pg';
import type { ServerLink } from '../door/server-link.js';
import { DEFAULT_TZ, localDay } from '../proactive/clock.js';
import type { OptionPlace } from '../travel/results.js';
import type { Travel } from '../travel/travel.js';
import { clip } from '../composer/sanitize.js';
import type { TripPack } from './pack.js';

export interface TripChange {
  title?: string | undefined;
  destination?: string | undefined;
  dates?: { start: string; end: string } | undefined;
  vibe?: string[] | undefined;
  stay?: string | undefined;
}

export interface SaveTripDeps {
  pool: Pool;
  now: () => Date;
  /** brain.travel, read when a change is saved (the travel lane registers after the lanes that save). */
  travel?: () => Travel | undefined;
}

/** quiet: the refusal is Go's own to fix, never the room's to hear; next: the same days this year or next. */
export type Saved =
  | { ok: true; changed: string[]; stay?: string; note?: string }
  | { ok: false; error: string; quiet?: boolean; next?: { start: string; end: string } };

/** Days said without a year mean the next ones: the same days this year, or next year when this year's have passed. */
export function nextDates(d: { start: string; end: string }, today: string): { start: string; end: string } {
  const year = Number(today.slice(0, 4));
  const shift = (`${year}${d.start.slice(4)}` >= today ? year : year + 1) - Number(d.start.slice(0, 4));
  const move = (day: string) => `${Number(day.slice(0, 4)) + shift}${day.slice(4)}`;
  return { start: move(d.start), end: move(d.end) };
}

/** Lowercase letters and digits only, so "Villa Sol," and "villa sol" compare equal. */
const plain = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Today in the trip's own time zone. */
export async function tripToday(d: SaveTripDeps, tripId: string): Promise<string> {
  const tz = (await d.pool.query<{ tz: string }>('select tz from trips where trip_id = $1', [tripId])).rows[0]?.tz ?? DEFAULT_TZ;
  return localDay(d.now(), tz);
}

/**
 * Checks a change and writes it to the Server. requestId is asked for only when the change is written, so a refused
 * change spends no id.
 */
export async function saveTrip(
  d: SaveTripDeps,
  at: { link: Pick<ServerLink, 'request'>; tripId: string; pack: TripPack; requestId: () => string },
  a: TripChange,
): Promise<Saved> {
  const fields: { title?: string; destination?: Place; dates?: { start: string; end: string }; vibe?: string[]; stay?: string } = {
    ...(a.title ? { title: a.title } : {}),
    ...(a.dates ? { dates: a.dates } : {}),
    ...(a.vibe ? { vibe: a.vibe } : {}),
    ...(a.stay ? { stay: a.stay } : {}),
  };
  if (Object.keys(fields).length === 0 && !a.destination) return { ok: false, error: 'Nothing to change.' };
  // A stay or place a vote decided is saved from the winning option's own data, never from the words given, and a
  // different one is refused: "Villa Sol, Assagao" for the Villa Sol in Anjuna the group voted for saves "Villa Sol, Anjuna".
  if (a.stay) {
    const won = await decided(d, at.pack, 'stay');
    if (won) {
      if (!` ${plain(a.stay)} `.includes(` ${plain(won.title)} `)) {
        return { ok: false, error: `The group voted for ${won.title}${won.area ? ` in ${won.area}` : ''}. Save that, or ask the group before changing the stay.`, quiet: true };
      }
      fields.stay = clip(won.area ? `${won.title}, ${won.area}` : won.title, 60);
    }
  }
  let note: string | undefined;
  if (a.destination) {
    let name = a.destination;
    const won = await decided(d, at.pack, 'place');
    if (won) {
      const voted = won.place?.name ?? won.title;
      if (!` ${plain(a.destination)} `.includes(` ${plain(voted)} `)) {
        return { ok: false, error: `The group voted for ${voted}. Save that, or ask the group before changing the place.`, quiet: true };
      }
      name = voted;
    }
    const place = await destinationOf(d, at, name);
    if ('error' in place) {
      // The rest of the change (the dates said with it) still saves.
      if (Object.keys(fields).length === 0) return { ok: false, error: place.error, quiet: true };
      note = place.error;
    } else if (!place.same) {
      fields.destination = place.place;
    }
  }
  if (Object.keys(fields).length === 0) return { ok: false, error: 'The trip already has that.', quiet: true };
  if (a.dates && a.dates.start > a.dates.end) return { ok: false, error: 'The start date is after the end date.' };
  if (a.dates) {
    const today = await tripToday(d, at.tripId);
    // A trip under way keeps the start it already has; any other day before today is a guessed year.
    if (a.dates.end < today || (a.dates.start < today && a.dates.start !== at.pack.trip.dates?.start)) {
      const next = nextDates(a.dates, today);
      return {
        ok: false,
        error: `Those dates are before today (${today} where the trip is). Use this year or next: ${next.start} to ${next.end}, if that is what the group meant.`,
        quiet: true,
        next,
      };
    }
  }
  await at.link.request('update_trip', { request_id: at.requestId(), trip_id: at.tripId, ...fields });
  return { ok: true, changed: Object.keys(fields), ...(fields.stay ? { stay: fields.stay } : {}), ...(note ? { note } : {}) };
}

/** The winner of the latest closed vote whose winning option is of this kind, with the option's own data. */
async function decided(d: SaveTripDeps, pack: TripPack, kind: 'stay' | 'place'): Promise<OptionPlace | null> {
  const travel = d.travel?.();
  if (!travel?.placeOf) return null;
  const closed = pack.trip.decisions
    .filter((x) => x.status === 'closed' && x.result_index !== null && x.result_index !== undefined)
    .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''));
  for (const x of closed) {
    const ref = x.options[x.result_index!]?.option_ref;
    if (!ref) continue;
    const option = await travel.placeOf(ref);
    if (option?.kind === kind) return option;
  }
  return null;
}

/** A place this close to the trip's destination is an area of it (Candolim is about 15 km from Goa's middle, Palolem 35). */
export const AREA_KM = 100;

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/**
 * Where the trip goes, as a full Place, or why not. An area inside the trip's destination (North Goa, Candolim, Anjuna) is
 * never the destination: it is where to stay there, a preference, or the stays search's place (the Server, 6 Oct: "a
 * wrong place saved on update_trip", "Candolim, Goa" over Goa after a vote on where to stay). A new destination is sent
 * as ixigo's full Place (place_id, lat/lng, photo, its time zone), never a bare name; one Go can't look up is the
 * organizer's to set in the App.
 */
async function destinationOf(
  d: SaveTripDeps,
  at: { tripId: string; pack: TripPack },
  name: string,
): Promise<{ place: Place; same?: false } | { same: true } | { error: string }> {
  const now = at.pack.trip.destination ?? null;
  if (now && plain(now.name) === plain(name)) return { same: true };
  const area = (current: string) =>
    `${name} is in ${current}: that is where in ${current} to stay, never where the trip goes. The trip stays ${current}; use ${name} for the stays search and the record.`;
  // "North Goa", "Candolim, Goa": the name says it is in the destination.
  if (now && ` ${plain(name)} `.includes(` ${plain(now.name)} `)) return { error: area(now.name) };
  const found = await d.travel?.()?.findPlace?.(name, { tripId: at.tripId });
  if (!found) return { error: `Go can't look up ${name} as a place right now, so the trip's place stays as it is. The organizer can change it in the App.` };
  if (now && plain(found.name) === plain(now.name)) return { same: true };
  // "Candolim": close to the destination, so an area of it.
  if (now && now.lat != null && now.lng != null && found.lat != null && found.lng != null && km({ lat: now.lat, lng: now.lng }, { lat: found.lat, lng: found.lng }) < AREA_KM) {
    return { error: area(now.name) };
  }
  return { place: found };
}

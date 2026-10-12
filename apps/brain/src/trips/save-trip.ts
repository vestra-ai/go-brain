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
import type { ResolvedPlace, Travel } from '../travel/travel.js';
import { clip } from '../composer/sanitize.js';
import { messageByRef, type TripPack } from './pack.js';

export interface TripChange {
  title?: string | undefined;
  destination?: string | undefined;
  dates?: { start: string; end: string } | undefined;
  vibe?: string[] | undefined;
  stay?: string | undefined;
  /** 1.1: the group's budget per person, in minor units (set_budget, travel/trip-budget.ts). */
  budgetPerPersonMinor?: number | undefined;
  /** The closed vote that decided a title, place or dates change (groupDecided). */
  decisionId?: string | undefined;
  /** A caller that holds the vote's winner itself: a place card's vote applied on close (placeOnClose). */
  agreed?: true | undefined;
  /** The chat's agreement on a title, place or dates with no vote: the proposal's message first, then the replies agreeing (chatAgreed). */
  agreedMessages?: readonly string[] | undefined;
}

/**
 * Who changes where the trip goes, its dates or its title: the group's vote, applied the moment it closes, and nobody's
 * word alone, the organizer's neither (Keshav, 11 Oct, after the Varkala trip: "for change of place voting was right
 * move but remove the organizer stuff"). A trip of one has no vote: their word is the decision.
 */
export function groupDecided(pack: TripPack, decisionId?: string): boolean {
  if (pack.trip.people.length <= 1) return true;
  return decisionId !== undefined && pack.trip.decisions.some((x) => x.decision_id === decisionId && x.status === 'closed');
}

/** A reaction that agrees: a thumbs up (any skin tone), a check, OK or praise hands, 100, a heart or a fire. */
const AGREES = ['👍', '✅', '✔', '👌', '🙌', '💯', '❤', '🔥'];

/**
 * The group agreed in the chat (Keshav, 12 Oct: "when the AI figures out something it should update, because the entire UI
 * is reactive"): the people behind the messages given (the proposal first, then the replies that agree) and those who
 * reacted to the proposal agreeing (4 ✅ on Aryan's "1 to 4 Nov") are more than half of the trip's people.
 */
export function chatAgreed(pack: TripPack, refs: readonly string[] | undefined): boolean {
  const found = (refs ?? []).map((r) => messageByRef(pack.messages, r)).filter((m) => m !== undefined);
  if (found.length === 0) return false;
  const people = new Set(pack.trip.people.map((p) => p.person_id));
  const agreed = new Set<string>();
  for (const m of found) if (m.author.kind === 'person' && people.has(m.author.person_id)) agreed.add(m.author.person_id);
  for (const r of found[0]!.reactions) {
    if (r.person_id && people.has(r.person_id) && AGREES.some((e) => r.emoji.startsWith(e))) agreed.add(r.person_id);
  }
  return agreed.size * 2 > people.size;
}

/** What Go hears when a title, place or dates change has no closed vote behind it. */
export const NOT_DECIDED =
  "The group's vote changes the trip's title, place or dates: give the closed vote (decision_id), or open the vote on it now.";

export interface SaveTripDeps {
  pool: Pool;
  now: () => Date;
  /** brain.travel, read when a change is saved (the travel lane registers after the lanes that save). */
  travel?: () => Travel | undefined;
}

/** quiet: the refusal is Go's own to fix, never the room's to hear; next: the same days this year or next. */
export type Saved =
  | { ok: true; changed: string[]; stay?: string; note?: string }
  | { ok: false; error: string; quiet?: boolean; next?: { start: string; end: string }; notDecided?: true };

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
  const fields: { title?: string; destination?: Place; dates?: { start: string; end: string }; vibe?: string[]; stay?: string; budget_per_person_minor?: number } = {
    ...(a.title ? { title: a.title } : {}),
    ...(a.budgetPerPersonMinor ? { budget_per_person_minor: a.budgetPerPersonMinor } : {}),
    ...(a.dates ? { dates: a.dates } : {}),
    ...(a.vibe ? { vibe: a.vibe } : {}),
    ...(a.stay ? { stay: a.stay } : {}),
  };
  if (Object.keys(fields).length === 0 && !a.destination) return { ok: false, error: 'Nothing to change.' };
  if ((a.title || a.destination || a.dates) && !a.agreed && !groupDecided(at.pack, a.decisionId) && !chatAgreed(at.pack, a.agreedMessages)) {
    return { ok: false, error: NOT_DECIDED, notDecided: true };
  }
  let note: string | undefined;
  // A stay or place a vote decided is saved from the winning option's own data, never from the words given, and a
  // different one is refused: "Villa Sol, Assagao" for the Villa Sol in Anjuna the group voted for saves "Villa Sol, Anjuna".
  if (a.stay) {
    const won = await decided(d, at.pack, 'stay');
    if (won) {
      if (!` ${plain(a.stay)} `.includes(` ${plain(won.title)} `)) {
        return { ok: false, error: `The group voted for ${won.title}${won.area ? ` in ${won.area}` : ''}. Save that, or ask the group before changing the stay.`, quiet: true };
      }
      fields.stay = clip(won.area ? `${won.title}, ${won.area}` : won.title, 60);
    } else {
      const picked = pickedStay(at.pack, a.stay);
      if (picked) fields.stay = clip(picked, 60);
      else {
        delete fields.stay;
        note = `${a.stay} is no stay the group picked yet (a vote's winner or a booked stay): keep it as a preference, and save the stay once the group picks one.`;
      }
    }
  }
  if (a.destination) {
    const won = await decided(d, at.pack, 'place');
    const voted = won ? (won.place?.name ?? won.title) : null;
    const named = voted !== null && ` ${plain(a.destination)} `.includes(` ${plain(voted)} `);
    // The place card names a place with its state ("Gokarna, Karnataka"), which ixigo pins only as the city: the city
    // alone is the group's pick (prod, 12 Oct: Gokarna won, and the trip never got a place).
    const city = voted !== null && voted.includes(',') ? voted.split(',')[0]!.trim() : null;
    const cityOfVote = !named && city !== null && city !== '' && plain(a.destination) === plain(city);
    const place = await destinationOf(d, at, named ? voted : a.destination);
    // A city in the place the group voted for is that place, pinned: Marrakech for Morocco, by ixigo's own word for
    // where Marrakech is, since ixigo pins no country (Varkala, 11 Oct).
    if (voted !== null && !named && !cityOfVote && !('within' in place && place.within.some((w) => plain(w) === plain(voted)))) {
      return { ok: false, error: `The group voted for ${voted}. Save that, or ask the group before changing the place.`, quiet: true };
    }
    if ('error' in place) note = note ? `${note} ${place.error}` : place.error;
    else if (!place.same) fields.destination = place.place;
  }
  // What could not be saved is said back to Go, never to the room; the rest of the change (the dates with it) saves.
  if (Object.keys(fields).length === 0) return { ok: false, error: note ?? 'The trip already has that.', quiet: true };
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

/**
 * Where the trip goes, as a full Place, or why not. update_trip never sends a bare {name} (the Server, 6 Oct: "a wrong
 * place saved on update_trip"; staging, 8 Oct: {"name":"Candolim, Goa"} over Goa, dropping its place_id, coordinates and
 * photo). A destination changes only to ixigo's resolved Place (travel.placeFor: place_id, lat/lng, photo, time zone);
 * a name that resolves to nothing leaves the destination as it is, and Go saves the city it means instead: a country or
 * a region (ixigo pins neither) is its main city for visitors.
 */
async function destinationOf(
  d: SaveTripDeps,
  at: { tripId: string; pack: TripPack },
  name: string,
): Promise<{ place: Place; within: string[]; same?: false } | { same: true } | { error: string }> {
  const now = at.pack.trip.destination ?? null;
  if (now && plain(now.name) === plain(name)) return { same: true };
  const stays = `the trip's place stays ${now ? now.name : 'unset'}`;
  let resolved: ResolvedPlace | null | undefined;
  const look = () => d.travel?.()?.placeFor?.(name, { tripId: at.tripId });
  try {
    resolved = await look();
  } catch {
    // Once more at once, then the model tries again on its next turn: nobody is sent to the App for it.
    try {
      resolved = await look();
    } catch {
      return { error: `ixigo didn't answer when Go looked up ${name}, twice, so ${stays} for now. Save it with update_trip again on your next turn.` };
    }
  }
  if (!resolved) {
    return {
      error:
        `ixigo pins no place called ${name}, so ${stays}. ixigo pins cities and states, never a country or a region: for one, call update_trip ` +
        `again now with its main city for visitors (Morocco: Marrakech) and the same decision_id, and say in your line which city ` +
        'the trip is set to. Where to stay goes in stay.',
    };
  }
  const found = resolved.place;
  if (now && plain(found.name) === plain(now.name)) return { same: true };
  // By ixigo's own data, not the words: an area (Candolim, Old Manali), or anything ixigo puts inside the trip's
  // destination, is where to stay there, never where the trip goes.
  const inside = now !== null && resolved.within.some((w) => plain(w) === plain(now.name));
  if (resolved.kind === 'area' || inside) {
    const where = resolved.within.length ? ` in ${resolved.within.join(', ')}` : '';
    return { error: `${found.name} is ${resolved.kind === 'area' ? 'an area' : 'a place'}${where}: where to stay, never where the trip goes, so ${stays}. Save it as the stay once the group picks it.` };
  }
  return { place: found, within: resolved.within };
}

/**
 * The stay as the group picked it: a closed vote's winning option ("Candolim" for "Where should we stay in Goa: Candolim
 * or Anjuna?") or a booked stay's title, the one the words name; null for a wish ("Villa with a pool in Candolim" names
 * no pick until a vote or a booking does), which stays a preference line in the record.
 */
export function pickedStay(pack: TripPack, said: string): string | null {
  const picks = [
    ...pack.trip.decisions.flatMap((x) => (x.status === 'closed' && x.result_index != null && x.options[x.result_index] ? [x.options[x.result_index]!.label] : [])),
    ...pack.trip.bookings.filter((b) => b.kind === 'stay').map((b) => b.title),
  ];
  const words = ` ${plain(said)} `;
  return picks.find((p) => plain(p) !== '' && words.includes(` ${plain(p)} `)) ?? null;
}

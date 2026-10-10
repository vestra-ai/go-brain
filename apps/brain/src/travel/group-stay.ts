/**
 * Where the group stays, for the ways there (the lead, 10 Oct): the stay they booked, else the stay a closed vote picked,
 * else the top pick on the trip's latest stays card. Only with the position ixigo gave it: a stay with none is never
 * guessed at, and never swapped for another (a booked stay with no position is no stay here, not the vote's winner).
 */
import type { Trip } from '../door/methods.js';
import type { ResultsStore } from './results.js';
import type { TravelSearch } from './travel.js';

export interface GroupStay {
  name: string;
  lat: number;
  lng: number;
  why: 'booked' | 'voted' | 'top';
}

/** How a line says whose stay it is: "Casa Anjuna, the stay you voted for". */
export const STAY_WHY: Record<GroupStay['why'], string> = {
  booked: 'the stay you booked',
  voted: 'the stay you voted for',
  top: 'the top stay on the last stays card',
};

type Decision = Trip['decisions'][number];

/** A closed vote's winning option, as the options card's option_id it came from; null when it has none. */
const winnerOf = (d: Decision | undefined): string | null =>
  d && d.status === 'closed' && typeof d.result_index === 'number' ? (d.options[d.result_index]?.option_ref ?? null) : null;

const placed = (name: string, p: { lat?: number | null; lng?: number | null } | null | undefined, why: GroupStay['why']): GroupStay | null =>
  p && typeof p.lat === 'number' && typeof p.lng === 'number' ? { name, lat: p.lat, lng: p.lng, why } : null;

export function createGroupStay(d: { trip: (tripId: string) => Promise<Trip>; results: Pick<ResultsStore, 'placeOf' | 'topPick'> }) {
  return async (tripId: string): Promise<GroupStay | null> => {
    const trip = await d.trip(tripId);
    const booked = trip.bookings
      .filter((b) => b.kind === 'stay' && b.status === 'confirmed')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (booked) {
      const name = booked.place?.name ?? booked.title;
      const own = placed(name, booked.place, 'booked');
      if (own) return own;
      // A stay Go booked from a vote: its position is the winning option's, as ixigo's search gave it.
      const ref = winnerOf(trip.decisions.find((x) => x.decision_id === booked.decision_id));
      const option = ref ? await d.results.placeOf(ref) : null;
      return option ? placed(name, option.place, 'booked') : null;
    }
    const closed = trip.decisions.filter((x) => winnerOf(x) !== null).sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''));
    for (const decision of closed) {
      const option = await d.results.placeOf(winnerOf(decision)!);
      if (option?.kind === 'stay') return placed(option.title, option.place, 'voted');
    }
    const top = await d.results.topPick(tripId, 'stay');
    return top ? placed(top.title, top.place, 'top') : null;
  };
}

/** Kilometres between two points on the Earth, in a straight line. */
export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** A bus's drops with a position, as the recipe reads them: "Panjim (15.4939, 73.8369); Mapusa (15.589, 73.8099)". */
function spotsOf(s: string): Array<{ name: string; lat: number; lng: number }> {
  return s.split('; ').flatMap((spot) => {
    const m = /^(.+) \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)$/.exec(spot.trim());
    return m ? [{ name: m[1]!, lat: Number(m[2]), lng: Number(m[3]) }] : [];
  });
}

/**
 * Each bus's nearest drop to the group's stay, from the drops ixigo placed, as its first highlight ("Get off at Mapusa,
 * about 3 km from Casa Anjuna") and its facts: a straight line, never a drive time. Worked out per trip, after the read,
 * since a read is shared across trips. A bus with no placed drop is left as it is.
 */
export function nearStay(found: TravelSearch, stay: GroupStay | null): TravelSearch {
  if (!stay) return found;
  let any = false;
  const results = found.results.map((o) => {
    const spots = typeof o.facts['drop_spots'] === 'string' ? spotsOf(o.facts['drop_spots']) : [];
    const near = spots.map((s) => ({ ...s, km: kmBetween(s, stay) })).sort((a, b) => a.km - b.km)[0];
    if (!near) return o;
    any = true;
    const far = near.km < 1 ? 'under 1 km' : `about ${Math.round(near.km)} km`;
    const line = `Get off at ${near.name}, ${far} from ${stay.name}`;
    return {
      ...o,
      highlights: [line.length > 80 ? `${line.slice(0, 79)}…` : line, ...o.highlights].slice(0, 4),
      facts: { ...o.facts, get_off: near.name, get_off_km: Math.round(near.km * 10) / 10 },
    };
  });
  return any ? { ...found, results, nearStay: `${stay.name}, ${STAY_WHY[stay.why]}` } : found;
}

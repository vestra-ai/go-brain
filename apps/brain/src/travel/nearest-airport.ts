/**
 * The nearest other airport with regular flights to a place whose own had none on ixigo that day (Keshav, 12 Oct: "if
 * there is no airport in source or destination, Sonnet should be smart enough to give the closest airport"). The cases
 * we know first (answer.ts nearestWithFlights), then the side model, in strict JSON, in at most 4 s: a 3-letter code
 * that is not the airport ixigo already searched, or nothing, and the bus is offered instead. Kept by the place's words
 * (an answer for good, a miss for 10 minutes), so a place is asked about once.
 */
import type { SideModel } from '../memory/side-model.js';
import { nearestWithFlights, noFlightsOffer, type NoFlightsOffer } from './answer.js';
import { norm } from './recipes/places.js';

export interface NearestFound {
  city: string;
  /** "about 7 h", when known. */
  road?: string;
}
export type NearestAirport = (place: string, searched?: { code: string; city: string }) => Promise<NearestFound | null>;

export const NEAREST_RULES =
  'You name the nearest airport with regular commercial flights to a place in India or abroad, other than the airport ' +
  'given as not. Answer with one JSON object and nothing else: {"city": the city people call that airport by, ' +
  '"iata": its 3-letter IATA code, "road_hours": hours by road from it to the place, a number}. ' +
  'When you are not sure, answer {"city": null, "iata": null, "road_hours": null}.';

const ASK_MS = 4_000;
const MISS_MS = 10 * 60_000;
const KEPT_MAX = 500;

export function createNearestAirport(d: { side: () => SideModel | null; now: () => Date; log?: { warn(obj: object, msg: string): void }; askMs?: number }): NearestAirport {
  const kept = new Map<string, { found: NearestFound | null; at: number }>();
  return async (place, searched) => {
    const known = nearestWithFlights(place, searched);
    if (known) return known;
    const key = `${norm(place)}|${searched?.code ?? ''}`;
    const hit = kept.get(key);
    if (hit && (hit.found || d.now().getTime() - hit.at < MISS_MS)) return hit.found;
    let found: NearestFound | null = null;
    try {
      const side = d.side();
      if (side) {
        const raw = await side.complete({
          purpose: 'nearest_airport', system: NEAREST_RULES, maxTokens: 120, signal: AbortSignal.timeout(d.askMs ?? ASK_MS),
          user: JSON.stringify({ place: place.slice(0, 80), not: searched ? `${searched.code} ${searched.city}` : null }),
        });
        found = readNearest(raw, searched?.code);
      }
    } catch (err) {
      d.log?.warn({ err: String(err).slice(0, 200) }, 'travel: the nearest airport could not be asked');
    }
    kept.set(key, { found, at: d.now().getTime() });
    while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
    return found;
  };
}

/** ixigo's none said, with the nearest airport offered for the trip's end, else the home's, found by nearest. */
export async function noFlightsOfferFor(
  from: string, to: string, date: string,
  none: { from?: { words: string; code: string; city: string }; to?: { words: string; code: string; city: string } },
  nearest?: NearestAirport,
): Promise<NoFlightsOffer> {
  if (!nearest) return noFlightsOffer(from, to, date, none);
  const there = await nearest(none.to?.words ?? to, none.to);
  const home = there ? null : await nearest(none.from?.words ?? from, none.from);
  return noFlightsOffer(from, to, date, none, { there, home });
}

/** The side model's answer, or null: a 3-letter code that is not the one searched, a short city name, the road in hours. */
export function readNearest(raw: string, searchedCode?: string): NearestFound | null {
  let v: unknown;
  try {
    v = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const o = v as { city?: unknown; iata?: unknown; road_hours?: unknown };
  const iata = typeof o.iata === 'string' ? o.iata.trim().toUpperCase() : '';
  const city = typeof o.city === 'string' ? o.city.trim() : '';
  if (!/^[A-Z]{3}$/.test(iata) || iata === searchedCode?.toUpperCase()) return null;
  if (!/^[\p{L} .'-]{2,40}$/u.test(city)) return null;
  const h = typeof o.road_hours === 'number' && Number.isFinite(o.road_hours) && o.road_hours > 0 && o.road_hours <= 24 ? Math.round(o.road_hours * 2) / 2 : null;
  return { city, ...(h !== null ? { road: `about ${h} h` } : {}) };
}

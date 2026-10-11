/**
 * A place by the words for it, as Go tells the Server about it (contract 1.1 Place): the trip's destination when Go sets
 * it (trips/save-trip.ts, through brain.travel.placeFor). ixigo's hotel box names it: its id, its type, where it is and
 * what it lies within. Its country gives its time zone, and ixigo's guide gives a destination its photo and up to twelve
 * labelled ones (the Server team's 10 Oct B3: the guide's own, its places to visit by name), through Go's image cache, and
 * its best months (rev 5 R6, for place_info). Kept for good by the words (place_details): one box lookup a place and one
 * guide load a destination, ever. A place kept before its months were (best_months null) is learned once more, and one
 * whose guide failed to load keeps trying, never losing what was kept. Nothing is made up: what ixigo doesn't say is left
 * out (a country with more than one time zone has none).
 */
import type { Photo, Place } from '@go/contract';
import type pg from 'pg';
import type { Engine } from './book/engine.js';
import type { Images } from './images.js';
import { photosOf, type SourcePhoto } from './photos.js';
import { norm } from './recipes/places.js';
import type { ResolvedPlace } from './travel.js';

export type PlaceFor = (words: string, o: { tripId: string }) => Promise<ResolvedPlace | null>;

export interface PlaceForDeps {
  pool: pg.Pool;
  engine: Pick<Engine, 'suggest' | 'answer'>;
  images: Pick<Images, 'rehostUrl'>;
  log?: { warn(obj: object, msg: string): void };
}

/** Countries with one time zone, by the names ixigo gives them. One with more than one (the US, Australia) has none. */
const ZONES: Record<string, string> = {
  India: 'Asia/Kolkata', Nepal: 'Asia/Kathmandu', Bhutan: 'Asia/Thimphu', 'Sri Lanka': 'Asia/Colombo', Bangladesh: 'Asia/Dhaka',
  Maldives: 'Indian/Maldives', 'United Arab Emirates': 'Asia/Dubai', UAE: 'Asia/Dubai', Qatar: 'Asia/Qatar', Oman: 'Asia/Muscat',
  Bahrain: 'Asia/Bahrain', Kuwait: 'Asia/Kuwait', 'Saudi Arabia': 'Asia/Riyadh', Thailand: 'Asia/Bangkok', Singapore: 'Asia/Singapore',
  Malaysia: 'Asia/Kuala_Lumpur', Vietnam: 'Asia/Ho_Chi_Minh', Cambodia: 'Asia/Phnom_Penh', Philippines: 'Asia/Manila', Japan: 'Asia/Tokyo',
  'South Korea': 'Asia/Seoul', 'Hong Kong': 'Asia/Hong_Kong', China: 'Asia/Shanghai', Taiwan: 'Asia/Taipei', 'United Kingdom': 'Europe/London',
  Ireland: 'Europe/Dublin', France: 'Europe/Paris', Germany: 'Europe/Berlin', Italy: 'Europe/Rome', Switzerland: 'Europe/Zurich',
  Austria: 'Europe/Vienna', Netherlands: 'Europe/Amsterdam', Belgium: 'Europe/Brussels', 'Czech Republic': 'Europe/Prague',
  Hungary: 'Europe/Budapest', Poland: 'Europe/Warsaw', Greece: 'Europe/Athens', Turkey: 'Europe/Istanbul', Egypt: 'Africa/Cairo',
  Mauritius: 'Indian/Mauritius', Seychelles: 'Indian/Mahe', Georgia: 'Asia/Tbilisi', Azerbaijan: 'Asia/Baku', Israel: 'Asia/Jerusalem',
  Jordan: 'Asia/Amman',
};

/** A place's IANA time zone from the country ixigo names; null for a country with more than one, or none named. */
export const timezoneOf = (country: string | null): string | null => (country ? (ZONES[country.trim()] ?? null) : null);

const KINDS: Record<string, ResolvedPlace['kind']> = { S: 'state', C: 'city' };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** The guide's best months (plan.destination's best_months), 1 to 12. */
const monthsOf = (v: unknown): number[] => (Array.isArray(v) ? v.filter((m): m is number => Number.isInteger(m) && m >= 1 && m <= 12) : []);

/** A place_details row: the place, and its best months, null until a guide answered for it. */
type KeptPlace = ResolvedPlace & { best_months: number[] | null };

/** The guide loads tried for a photo: the place itself, then what it lies in (Old Manali's is Manali's). */
const PHOTO_TRIES = 2;

/** What ixigo's guide gives a place: its own name for it, its photo and labelled photos (re-hosted), and its best months. */
export interface Guide {
  name: string | null;
  photo: string | null;
  photos: Photo[];
  /** [] when the guides answered with none, null when no guide answered at all. */
  months: number[] | null;
}
export type GuideOf = (names: string[], tripId: string) => Promise<Guide>;

/**
 * ixigo's guide photo for the first of these that has one, and that guide's labelled photos, through Go's image cache;
 * none when no guide has a photo. The months are the first guide's that names any.
 */
export function createGuideOf(d: Pick<PlaceForDeps, 'engine' | 'images' | 'log'>): GuideOf {
  return async (names, tripId) => {
    let months: number[] | null = null;
    for (const name of names.slice(0, PHOTO_TRIES)) {
      try {
        const guide = await d.engine.answer('plan.destination', { place: name }, { tripId });
        const row = guide.as === 'facts' ? guide.rows[0] : undefined;
        if (!months?.length) months = monthsOf(row?.['best_months']);
        const photo = row?.['photo'];
        if (typeof photo !== 'string') continue;
        const list = row?.['photos'];
        // "Kerala, India": the place's own name is before the country.
        const dest = row?.['destination'];
        const own = typeof dest === 'string' ? dest.split(',')[0]!.trim() : '';
        return {
          name: own || null,
          photo: await d.images.rehostUrl(photo),
          photos: Array.isArray(list) ? await photosOf(list as SourcePhoto[], d.images) : [],
          months,
        };
      } catch (err) {
        d.log?.warn({ err: String(err), tripId, place: name }, "travel: ixigo's guide gave no photo for a place");
      }
    }
    return { name: null, photo: null, photos: [], months };
  };
}

/**
 * A place's photo Go has kept already (place_details, by the words: the place as named, or the name before its first
 * comma), reading no page: null when none is kept.
 */
export async function keptPhoto(pool: pg.Pool, words: string): Promise<string | null> {
  const keys = [...new Set([norm(words), norm(words.split(',')[0] ?? '')])].filter((k) => k.length > 1);
  const r = await pool.query<{ photo: string | null }>("select place->>'photo_url' as photo from place_details where words = any($1::text[])", [keys]);
  return r.rows.find((x) => typeof x.photo === 'string' && x.photo !== '')?.photo ?? null;
}

export function createPlaceFor(d: PlaceForDeps): PlaceFor {
  const guideOf = createGuideOf(d);
  const resolvedOf = (k: KeptPlace): ResolvedPlace => ({ place: k.place, kind: k.kind, within: k.within });

  return async (words, o) => {
    const key = norm(words);
    if (key.length < 2) return null;
    const kept = (await d.pool.query<KeptPlace>('select place, kind, within, best_months from place_details where words = $1', [key])).rows[0];
    if (kept && kept.best_months !== null) return resolvedOf(kept);
    const s = await d.engine.suggest('hotels.place_lookup', words, { tripId: o.tripId });
    if (!s) return kept ? resolvedOf(kept) : null;
    const p = s.place;
    const kind = KINDS[String(p['locationType'])] ?? 'area';
    // ixigo's second line: "Manali, Himachal Pradesh" under Old Manali; Manali itself lies in Himachal Pradesh alone.
    const within = s.line.split(',').map((x) => x.trim()).filter((x) => x.length > 0 && norm(x) !== norm(s.name));
    const [lat, lng] = [num(p['lat']), num(p['lng'])];
    const timezone = timezoneOf(s.country);
    const { photo, photos, months } = await guideOf([s.name, ...within], o.tripId);
    // No guide answered this time: what was kept stays as it was, to be learned another time.
    if (kept && months === null) return resolvedOf(kept);
    const place: Place = {
      name: s.name.slice(0, 120),
      ...(p['locationId'] !== undefined ? { place_id: `ixigo:${String(p['locationId'])}` } : {}),
      ...(lat !== null && lng !== null ? { lat, lng } : {}),
      ...(timezone ? { timezone } : {}),
      ...(photo ? { photo_url: photo } : {}),
      ...(photos.length ? { photos } : {}),
    };
    const resolved: ResolvedPlace = { place, kind, within };
    await d.pool
      .query(
        `insert into place_details (words, place, kind, within, best_months) values ($1, $2, $3, $4, $5)
         on conflict (words) do update set place = excluded.place, kind = excluded.kind, within = excluded.within,
           best_months = excluded.best_months, learned_at = now()`,
        [key, place, kind, within, months],
      )
      .catch((err: unknown) => d.log?.warn({ err: String(err), place: key }, 'travel: a place could not be kept'));
    return resolved;
  };
}

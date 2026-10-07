/**
 * travel_places: the places ixigo's own search forms resolved, kept so they outlive a deploy. A search that ran ixigo's
 * form lands on ixigo's results page, whose URL carries ixigo's codes for its places: those are read off the URL and
 * learnt for the words people used (learnFromPage), so the next search for the same words opens the results page
 * directly. At boot every row goes back into places.ts (loadLearnedPlaces).
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import type { TravelKind } from '../travel.js';
import { learnPlace, wordsOf, type LearnedPlace } from './places.js';

const Places = {
  flights: z.object({ code: z.string().regex(/^[A-Z]{3}$/), city: z.string().min(1) }),
  trains: z.object({ code: z.string().regex(/^[A-Z]{1,5}$/), name: z.string().min(1) }),
  buses: z.object({ name: z.string().min(1), id: z.int().positive() }),
  stays: z.object({
    locationId: z.int().positive(), locationName: z.string().min(1), locationType: z.string().regex(/^[A-Z]{1,3}$/),
    masterLocationId: z.int().positive(), countryId: z.int().positive(),
  }),
} satisfies { [K in TravelKind]: z.ZodType<LearnedPlace[K]> };

/** Puts every place kept in travel_places back into the cache; a row that no longer reads is skipped. */
export async function loadLearnedPlaces(pool: Pool): Promise<number> {
  const r = await pool.query<{ kind: TravelKind; words: string; place: unknown }>('SELECT kind, words, place FROM travel_places ORDER BY learned_at');
  let n = 0;
  for (const row of r.rows) {
    const place = Places[row.kind]?.safeParse(row.place);
    if (!place?.success) continue;
    learnPlace(row.kind, row.words, place.data as LearnedPlace[typeof row.kind]);
    n += 1;
  }
  return n;
}

/** The words people used for each end of a search: from and to, or the stay's place. */
export interface SearchWords { from?: string; to?: string; area?: string }

const titled = (words: string): string => words.trim().replace(/\s+/g, ' ').replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase());
const int = (s: string | null | undefined): number => Number.parseInt(s ?? '', 10);

/**
 * The places a results page's URL carries, by the end of the search they belong to. The URL shapes are ixigo's own,
 * the same ones each recipe opens: /search/result/flight?from=LHR&to=DEL…, /search/result/train/NDLS/MAO/…,
 * /buses/bus_search/Mumbai/4/Goa/102/…, /hotels/search/result?locationId=…. Null when the URL is none of these.
 */
export function placesOnPage(kind: TravelKind, url: string, words: SearchWords): Partial<Record<keyof SearchWords, unknown>> | null {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return null;
  }
  const q = page.searchParams;
  const path = page.pathname.split('/').map((p) => decodeURIComponent(p));
  switch (kind) {
    case 'flights':
      if (page.pathname !== '/search/result/flight') return null;
      return {
        from: { code: q.get('from') ?? '', city: titled(words.from ?? '') },
        to: { code: q.get('to') ?? '', city: titled(words.to ?? '') },
      };
    case 'trains':
      // /search/result/train/{from}/{to}/{date}/…
      if (path[1] !== 'search' || path[2] !== 'result' || path[3] !== 'train') return null;
      return { from: { code: path[4] ?? '', name: titled(words.from ?? '') }, to: { code: path[5] ?? '', name: titled(words.to ?? '') } };
    case 'buses':
      // /buses/bus_search/{FromName}/{fromId}/{ToName}/{toId}/{DD-MM-YYYY}/O
      if (path[1] !== 'buses' || path[2] !== 'bus_search') return null;
      return { from: { name: path[3] ?? '', id: int(path[4]) }, to: { name: path[5] ?? '', id: int(path[6]) } };
    case 'stays':
      if (page.pathname !== '/hotels/search/result') return null;
      return {
        area: {
          locationId: int(q.get('locationId')), locationName: q.get('locationName') ?? '', locationType: q.get('locationType') ?? '',
          masterLocationId: int(q.get('masterLocationId')), countryId: int(q.get('countryId')),
        },
      };
  }
}

/**
 * Learns each place a results page carries for the words people used, in the cache and in travel_places. A place that
 * doesn't read (a URL ixigo changed) is not learnt. Returns how many were.
 */
export async function learnFromPage(pool: Pool, kind: TravelKind, words: SearchWords, url: string): Promise<number> {
  const found = placesOnPage(kind, url, words);
  if (!found) return 0;
  let n = 0;
  for (const end of ['from', 'to', 'area'] as const) {
    const said = words[end];
    const place = said === undefined ? null : Places[kind].safeParse(found[end]);
    if (!said || !place?.success) continue;
    learnPlace(kind, said, place.data as LearnedPlace[typeof kind]);
    await pool.query(
      `INSERT INTO travel_places (kind, words, place, page_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, words) DO UPDATE SET place = EXCLUDED.place, page_url = EXCLUDED.page_url, learned_at = now()`,
      [kind, wordsOf(said), JSON.stringify(place.data), url],
    );
    n += 1;
  }
  return n;
}

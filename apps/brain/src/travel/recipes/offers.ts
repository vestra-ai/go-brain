/**
 * What a site offers to narrow and order a search, as the site itself lists it (a recipe's `offers`: hotels.search reads
 * ixigo's own filter and sort lists from the call its results page makes, with how many stays each has). Read at run time
 * and kept per recipe and place for OFFERS_TTL_MS; shown to the model with the trip's context (offersNow), which maps the
 * group's ask onto it by name (site_filters, site_sort). Go keeps no list of its own: a name the site doesn't list is the
 * model's to pick on from the results.
 */
export interface Offer {
  kind: 'filter' | 'sort';
  /** The site's own heading for it ("Facilities", "Star Rating", "Sort"). */
  group: string;
  name: string;
  /** The site's own code for it, as its page takes it (FL_HF_29, SC_P_LH). */
  code: string;
}

export interface OfferList {
  recipeId: string;
  /** What the list is for, in words ("stays in Goa"). */
  about: string;
  offers: Offer[];
  at: number;
}

/** How long a site's list is kept: what a place's stays can be filtered by changes slowly. */
export const OFFERS_TTL_MS = 12 * 60 * 60_000;
const KEPT_MAX = 500;
const TRIPS_MAX = 2_000;

export interface Offers {
  /** The list a page read brought, for the recipe and its place (key), and the trip whose read it was. */
  keep(recipeId: string, key: string, about: string, offers: Offer[], tripId: string): void;
  /** The list kept for the recipe and place, inside its time; null when there is none. */
  get(recipeId: string, key: string): OfferList | null;
  /** The lists the trip's own reads brought, inside their time, newest first. */
  forTrip(tripId: string): OfferList[];
}

export function createOffers(o: { now: () => Date; ttlMs?: number }): Offers {
  const ttl = o.ttlMs ?? OFFERS_TTL_MS;
  const lists = new Map<string, OfferList>();
  const trips = new Map<string, Set<string>>();
  const fresh = (l: OfferList | undefined): l is OfferList => l !== undefined && o.now().getTime() - l.at < ttl;
  const bound = <V>(m: Map<string, V>, max: number): void => {
    while (m.size > max) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  };
  return {
    keep(recipeId, key, about, offers, tripId) {
      if (offers.length === 0) return;
      const k = `${recipeId}|${key}`;
      lists.delete(k);
      lists.set(k, { recipeId, about, offers, at: o.now().getTime() });
      bound(lists, KEPT_MAX);
      const mine = trips.get(tripId) ?? new Set<string>();
      mine.delete(k);
      mine.add(k);
      trips.delete(tripId);
      trips.set(tripId, mine);
      bound(trips, TRIPS_MAX);
    },
    get(recipeId, key) {
      const l = lists.get(`${recipeId}|${key}`);
      return fresh(l) ? l : null;
    },
    forTrip(tripId) {
      return [...(trips.get(tripId) ?? [])].reverse().map((k) => lists.get(k)).filter(fresh);
    },
  };
}

const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.+₹]+/g, ' ').trim();

/** An offer as the group reads it: its name, or with its heading when the name is a bare number ("Star Rating 5"). */
export const offerWords = (o: Offer): string => (/^[\d.+]+$/.test(o.name.trim()) ? `${o.group} ${o.name}` : o.name);

/**
 * The names asked for, as the site lists them: each matches an offer of that kind by its name, its words, or its heading
 * and name ("Star Rating: 5"), case, spacing and punctuation aside. The rest are not the site's (unknown).
 */
export function pickOffers(offers: Offer[], names: string[], kind: Offer['kind']): { picked: Offer[]; unknown: string[] } {
  const picked: Offer[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const want = plain(name);
    const hit = offers.find((o) => o.kind === kind && [o.name, offerWords(o), `${o.group} ${o.name}`].some((s) => plain(s) === want));
    if (!hit) unknown.push(name);
    else if (!picked.includes(hit)) picked.push(hit);
  }
  return { picked, unknown };
}

/** The most names of one heading the model reads, in the site's own order (ixigo's hotel chains run to about sixty). */
export const NAMES_PER_GROUP = 40;

/** A list as the model reads it: each heading with its names, the site's first NAMES_PER_GROUP, then the sorts. */
export function offersText(l: OfferList): string {
  const groups = new Map<string, string[]>();
  for (const o of l.offers) {
    const g = o.kind === 'sort' ? 'Sort' : o.group;
    groups.set(g, [...(groups.get(g) ?? []), o.name]);
  }
  return [...groups.entries()]
    .map(([g, names]) => `${g}: ${names.slice(0, NAMES_PER_GROUP).join(', ')}${names.length > NAMES_PER_GROUP ? ` and ${names.length - NAMES_PER_GROUP} more` : ''}`)
    .join('; ');
}

/** The site's names as it sends them, its HTML entities read ("Adamo hotels &amp; resorts"). */
const unescaped = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

/** Rows a recipe's offers list gave, kept only when each is one: a kind, a heading, a name and a code. */
export function asOffers(rows: unknown): Offer[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .flat(3)
    .filter((r): r is Offer => {
      const o = r as Partial<Offer> | null;
      return (
        !!o && (o.kind === 'filter' || o.kind === 'sort') && typeof o.group === 'string' && typeof o.name === 'string' && o.name.trim() !== '' &&
        typeof o.code === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(o.code)
      );
    })
    .map((o) => ({ kind: o.kind, group: unescaped(o.group), name: unescaped(o.name), code: o.code }));
}

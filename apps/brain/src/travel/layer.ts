/**
 * brain.travel. Picks the backend on every call from the TRAVEL_MODE switch (the fake when the one it names is not set
 * up), caches each search for three minutes with the time it was checked, applies constraints in code on every call,
 * and routes a hold or a confirm to the backend that made the offer. A search or a hold for a check-in or departure
 * before today in the trip's time zone is refused before any backend sees it, with the date to use instead.
 * ixigo_web searches ixigo.com itself, in the trip's browser: its options are link only, and status comes from ixigo's
 * MCP server when that is set up (never from the fake, whose readings are simulated).
 */
import type { Switches } from '../admin/switches.js';
import { localDay } from '../proactive/clock.js';
import { DEFAULT_TRIP_TZ, nextOccurrence } from './dates.js';
import { applyConstraints, closest } from './filters.js';
import { TravelError } from './mcp-travel.js';
import type { ResultsStore } from './results.js';
import { TravelQuery, type OfferRef, type Travel, type TravelBackend, type TravelKind, type TravelOptionKind, type TravelSearch } from './travel.js';

export const SEARCH_CACHE_MS = 180_000;
const CACHE_MAX = 500;

export interface TravelLayerDeps {
  switches: Pick<Switches, 'get'>;
  now: () => Date;
  fake: TravelBackend;
  ixigo: TravelBackend | null;
  /** ixigo.com through the recipes (TRAVEL_MODE ixigo_web). */
  ixigoWeb?: TravelBackend | null;
  results: Pick<ResultsStore, 'offer'> & Partial<Pick<ResultsStore, 'searchedFor' | 'placeOf'>>;
  /** Today (YYYY-MM-DD) in the trip's time zone. Default: India's. */
  today?: (tripId: string | null) => Promise<string>;
  simulate?: NonNullable<Travel['simulate']>;
  cacheMs?: number;
}

/** The part of a query the backend sees; the rest are constraints Go applies itself. */
function backendQuery(q: TravelQuery): TravelQuery {
  return {
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.date ? { date: q.date } : {}),
    ...(q.area ? { area: q.area } : {}),
    ...(q.checkIn ? { checkIn: q.checkIn } : {}),
    ...(q.checkOut ? { checkOut: q.checkOut } : {}),
    ...(q.guests ? { guests: q.guests } : {}),
  };
}

const keyOf = (q: TravelQuery): string =>
  JSON.stringify(Object.entries(q).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === 'string' ? v.trim().toLowerCase() : v]));

export function createTravelLayer(d: TravelLayerDeps): Travel {
  const ttl = d.cacheMs ?? SEARCH_CACHE_MS;
  const today = d.today ?? (async () => localDay(d.now(), DEFAULT_TRIP_TZ));
  const cache = new Map<string, { at: number; value: TravelSearch }>();
  const pick = (): { name: 'fake' | 'ixigo' | 'ixigo_web'; b: TravelBackend } => {
    const mode = d.switches.get('TRAVEL_MODE');
    if (mode === 'ixigo_web' && d.ixigoWeb) return { name: 'ixigo_web', b: d.ixigoWeb };
    return mode === 'ixigo' && d.ixigo ? { name: 'ixigo', b: d.ixigo } : { name: 'fake', b: d.fake };
  };
  const byPrefix = (id: string): TravelBackend => {
    if (id.startsWith('fake:')) return d.fake;
    if (id.startsWith('ixigo:') && d.ixigo) return d.ixigo;
    throw new TravelError('unknown_offer', `No travel backend for ${id}.`);
  };
  return {
    async search(kind: TravelKind, q: TravelQuery, o?: { tripId?: string }) {
      const parsed = TravelQuery.parse(q);
      const day = parsed.checkIn ?? parsed.date;
      if (day) {
        const todayIs = await today(o?.tripId ?? null);
        if (day < todayIs) {
          throw new TravelError(
            'past_date',
            `The ${parsed.checkIn ? 'check-in' : 'departure'} ${day} is before today (${todayIs} in the trip's time zone). Use this year's or next year's date, such as ${nextOccurrence(day, todayIs)}, and search again.`,
          );
        }
      }
      const { name, b } = pick();
      const base = backendQuery(parsed);
      // ixigo_web reads the page in the trip's own browser, for the trip's head count: its results are the trip's.
      const key = `${name}|${name === 'ixigo_web' ? (o?.tripId ?? '') : ''}|${kind}|${keyOf(base)}`;
      const nowMs = d.now().getTime();
      let hit = cache.get(key);
      if (!hit || nowMs - hit.at > ttl) {
        hit = { at: nowMs, value: await b.search(kind, base, o) };
        cache.delete(key);
        cache.set(key, hit);
        while (cache.size > CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      const all = hit.value.results;
      const results = applyConstraints(kind, parsed, all);
      const near = results.length === 0 ? closest(kind, parsed, all) : null;
      return { checkedAt: hit.value.checkedAt, results, found: all.length, ...(near ? { closest: near } : {}) };
    },
    async status(q) {
      const { name, b } = pick();
      return name === 'ixigo_web' && d.ixigo ? d.ixigo.status(q) : b.status(q);
    },
    simulated: () => pick().name === 'fake',
    async hold(offerId, lead) {
      // The day the offer was searched for: a vote that outlived it cannot book the past.
      const searched = await d.results.searchedFor?.(offerId);
      if (searched?.day) {
        const todayIs = await today(searched.tripId);
        if (searched.day < todayIs) {
          throw new TravelError('past_date', `That offer is for ${searched.day}, which has passed (today is ${todayIs} in the trip's time zone). Search again for this year's or next year's date.`);
        }
      }
      return byPrefix(offerId).hold(offerId, lead);
    },
    async confirm(holdId, paid) {
      return byPrefix(holdId).confirm(holdId, paid);
    },
    async placeOf(optionId) {
      return d.results.placeOf ? d.results.placeOf(optionId) : null;
    },
    async offer(optionId): Promise<OfferRef | null> {
      const o = await d.results.offer(optionId);
      if (!o) return null;
      // A vote and a payment use the whole stay; the card shows the nightly price.
      // kind lets P5 refuse what Go cannot book for a group yet (flights, trains, buses); link is the option's own page
      // (ixigo.com's, for ixigo_web), so the group can book it there, and null when it has none.
      return { offerId: o.offerId, title: o.title, priceMinor: o.totalMinor ?? o.priceMinor, currency: o.currency, kind: o.kind as TravelOptionKind, link: o.sourceUrl ?? null };
    },
    ...(d.simulate ? { simulate: d.simulate } : {}),
  };
}

/**
 * brain.travel. Picks the backend on every call from the TRAVEL_MODE switch (the fake when ixigo is not set up),
 * caches each search for three minutes with the time it was checked, applies constraints in code on every call,
 * and routes a hold or a confirm to the backend that made the offer. A search or a hold for a check-in or departure
 * before today in the trip's time zone is refused before any backend sees it, with the date to use instead.
 */
import type { Switches } from '../admin/switches.js';
import { localDay } from '../proactive/clock.js';
import { DEFAULT_TRIP_TZ, nextOccurrence } from './dates.js';
import { applyConstraints } from './filters.js';
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
  results: Pick<ResultsStore, 'offer'> & Partial<Pick<ResultsStore, 'searchedFor'>>;
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
  const pick = (): { name: 'fake' | 'ixigo'; b: TravelBackend } =>
    d.switches.get('TRAVEL_MODE') === 'ixigo' && d.ixigo ? { name: 'ixigo', b: d.ixigo } : { name: 'fake', b: d.fake };
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
      const key = `${name}|${kind}|${keyOf(base)}`;
      const nowMs = d.now().getTime();
      let hit = cache.get(key);
      if (!hit || nowMs - hit.at > ttl) {
        hit = { at: nowMs, value: await b.search(kind, base) };
        cache.delete(key);
        cache.set(key, hit);
        while (cache.size > CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return { checkedAt: hit.value.checkedAt, results: applyConstraints(kind, parsed, hit.value.results) };
    },
    async status(q) {
      return pick().b.status(q);
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
    async offer(optionId): Promise<OfferRef | null> {
      const o = await d.results.offer(optionId);
      if (!o) return null;
      // A vote and a payment use the whole stay; the card shows the nightly price.
      // kind lets P5 refuse what Go cannot book for a group yet (flights, trains, buses); link is ixigo's own page for
      // the offer, filled once ixigo's tools are mapped (Task 23), and null until then.
      return {
        offerId: o.offerId, title: o.title, priceMinor: o.totalMinor ?? o.priceMinor, currency: o.currency, kind: o.kind as TravelOptionKind, link: null,
        place: o.place ?? null, area: o.area ?? null,
      };
    },
    ...(d.simulate ? { simulate: d.simulate } : {}),
  };
}

/**
 * brain.travel. Picks the backend on every call from the TRAVEL_MODE switch (the fake when ixigo is not set up),
 * caches each search for three minutes with the time it was checked, applies constraints in code on every call,
 * and routes a hold or a confirm to the backend that made the offer.
 */
import type { Switches } from '../admin/switches.js';
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
  results: Pick<ResultsStore, 'offer'>;
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
  const cache = new Map<string, { at: number; value: TravelSearch }>();
  const pick = (): { name: 'fake' | 'ixigo'; b: TravelBackend } =>
    d.switches.get('TRAVEL_MODE') === 'ixigo' && d.ixigo ? { name: 'ixigo', b: d.ixigo } : { name: 'fake', b: d.fake };
  const byPrefix = (id: string): TravelBackend => {
    if (id.startsWith('fake:')) return d.fake;
    if (id.startsWith('ixigo:') && d.ixigo) return d.ixigo;
    throw new TravelError('unknown_offer', `No travel backend for ${id}.`);
  };
  return {
    async search(kind: TravelKind, q: TravelQuery) {
      const parsed = TravelQuery.parse(q);
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
      return { offerId: o.offerId, title: o.title, priceMinor: o.totalMinor ?? o.priceMinor, currency: o.currency, kind: o.kind as TravelOptionKind, link: null };
    },
    ...(d.simulate ? { simulate: d.simulate } : {}),
  };
}

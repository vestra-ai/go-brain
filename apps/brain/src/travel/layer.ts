/**
 * brain.travel. Picks the backend on every call from the TRAVEL_MODE switch (the fake when the one it names is not set
 * up), caches each search for three minutes with the time it was checked (ixigo_web keeps its own, for ten minutes, by
 * recipe and slots), applies constraints in code on every call,
 * and routes a hold or a confirm to the backend that made the offer. A search or a hold for a check-in or departure
 * before today in the trip's time zone is refused before any backend sees it, with the date to use instead.
 * ixigo_web searches ixigo.com itself, in the trip's browser: its options are link only, except its stays, which book on
 * Go's test rail once the trip's ixigo login is in (travel/web-stays.ts), and status comes from ixigo's MCP server when
 * that is set up (never from the fake, whose readings are simulated).
 */
import type { Switches } from '../admin/switches.js';
import { localDay } from '../proactive/clock.js';
import { ixigoPage } from './cards.js';
import { DEFAULT_TRIP_TZ, nextOccurrence } from './dates.js';
import { applyConstraints, nearest } from './filters.js';
import { TravelError } from './mcp-travel.js';
import type { PlaceFor } from './place-for.js';
import type { ResultsStore } from './results.js';
import { checkInOf, WEB_STAY, type WebStays } from './web-stays.js';
import { TravelQuery, type OfferRef, type SearchFor, type Travel, type TravelBackend, type TravelKind, type TravelOptionKind, type TravelSearch } from './travel.js';

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
  /** Stays from ixigo.com, booked on Go's test rail once the trip's ixigo login is in (travel/web-stays.ts). */
  webStays?: WebStays | null;
  /** A place by its words as ixigo knows it (travel/place-for.ts): only under ixigo_web, where Go reads ixigo.com. */
  placeFor?: PlaceFor | null;
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

/**
 * What a backend sees. ixigo_web also sees the must-haves, and the site's own filters and sort: ixigo filters on them
 * itself, so its list holds the right stays.
 */
const queryFor = (backend: string, q: TravelQuery): TravelQuery =>
  backend === 'ixigo_web'
    ? {
        ...backendQuery(q),
        ...(q.mustHave ? { mustHave: q.mustHave } : {}),
        // A bus's named pickup or drop: ixigo's own chip for it is clicked on the stage.
        ...(q.boardAt ? { boardAt: q.boardAt } : {}),
        ...(q.dropAt ? { dropAt: q.dropAt } : {}),
        ...(q.siteFilters?.length ? { siteFilters: q.siteFilters } : {}),
        ...(q.siteSort ? { siteSort: q.siteSort } : {}),
      }
    : backendQuery(q);

const keyOf = (q: TravelQuery): string =>
  JSON.stringify(Object.entries(q).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === 'string' ? v.trim().toLowerCase() : v]));

export function createTravelLayer(d: TravelLayerDeps): Travel {
  const ttl = d.cacheMs ?? SEARCH_CACHE_MS;
  const today = d.today ?? (async () => localDay(d.now(), DEFAULT_TRIP_TZ));
  const cache = new Map<string, { at: number; value: Promise<TravelSearch> }>();
  /**
   * A search kept for three minutes from its start, and shared while it runs: the composer's search_* call joins the
   * one the early start began. One that fails is not kept. ixigo_web keeps its own (by recipe and slots, ten minutes).
   */
  const kept = (key: string, search: () => Promise<TravelSearch>): Promise<TravelSearch> => {
    const nowMs = d.now().getTime();
    const hit = cache.get(key);
    if (hit && nowMs - hit.at <= ttl) return hit.value;
    const value = search();
    cache.delete(key);
    cache.set(key, { at: nowMs, value });
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return value;
  };
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
    async search(kind: TravelKind, q: TravelQuery, o?: SearchFor) {
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
      const base = queryFor(name, parsed);
      const found = name === 'ixigo_web' ? await b.search(kind, base, o) : await kept(`${name}|${kind}|${keyOf(base)}`, () => b.search(kind, base, o));
      const all = found.results;
      // Conditions ixigo did not filter on (unapplied): the options that say them fit as ever; when none does, the options
      // without those conditions, and the search says it left them off. The site's own filters it left off are no Go
      // check's: they go on, for the model to pick from the results.
      // The site's own sort, when it applied one, is the order the group asked for: Go keeps it.
      const order = { keepOrder: !!found.site?.sorted };
      const fit = applyConstraints(kind, parsed, all, order);
      const mustHave: readonly string[] = parsed.mustHave ?? [];
      const off = fit.length === 0 ? (found.unapplied ?? []).filter((c) => mustHave.includes(c)) : [];
      const loose = off.length > 0 ? applyConstraints(kind, { ...parsed, mustHave: (parsed.mustHave ?? []).filter((c) => !off.includes(c)) }, all, order) : [];
      const results = loose.length > 0 ? loose : fit;
      const unapplied = [...(loose.length > 0 ? off : []), ...(found.unapplied ?? []).filter((c) => !mustHave.includes(c))];
      // When none fits, or fewer than three stays: the nearest of the rest, so a card can show how near ixigo gets.
      const short = results.length === 0 || (kind === 'stays' && results.length < 3);
      const near = short ? nearest(kind, parsed, all.filter((o) => !results.includes(o)), 3 - results.length) : [];
      return {
        checkedAt: found.checkedAt, results, found: all.length, ...(near.length > 0 ? { nearest: near } : {}), ...(found.runId ? { runId: found.runId } : {}),
        ...(found.page ? { page: found.page } : {}), ...(unapplied.length > 0 ? { unapplied } : {}), ...(found.site ? { site: found.site } : {}),
        ...(found.earlier ? { earlier: true } : {}),
      };
    },
    async waitMs(kind, q, o) {
      const { name, b } = pick();
      return b.waitMs ? b.waitMs(kind, queryFor(name, TravelQuery.parse(q)), o) : null;
    },
    async status(q) {
      const { name, b } = pick();
      return name === 'ixigo_web' && d.ixigo ? d.ixigo.status(q) : b.status(q);
    },
    simulated: () => pick().name === 'fake',
    async hold(offerId, lead) {
      if (offerId.startsWith(WEB_STAY) && d.webStays) return d.webStays.hold(offerId, lead);
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
      if (holdId.startsWith(WEB_STAY) && d.webStays) return d.webStays.confirm(holdId, paid);
      return byPrefix(holdId).confirm(holdId, paid);
    },
    async placeOf(optionId) {
      return d.results.placeOf ? d.results.placeOf(optionId) : null;
    },
    async placeFor(words, o) {
      return d.placeFor && d.switches.get('TRAVEL_MODE') === 'ixigo_web' ? d.placeFor(words, o) : null;
    },
    async offer(optionId): Promise<OfferRef | null> {
      const o = await d.results.offer(optionId);
      if (!o) return null;
      // A vote and a payment use the whole stay; the card shows the nightly price.
      // kind lets P5 refuse what Go cannot book for a group yet (flights, trains, buses); link is the option's own page on
      // ixigo.com (ixigo_web), where the group can book it, and null otherwise: a page a job found elsewhere is not handed out.
      // A stay from ixigo.com has no offer of its own: it gets Go's web-stay offer, booked on the test rail after the login.
      const offerId = o.offerId ?? d.webStays?.offerIdFor(o) ?? null;
      // The day it is for: what its search asked, or a stay page's own check-in. A vote that outlived it cannot book the past.
      const day = (o.offerId ? (await d.results.searchedFor?.(o.offerId))?.day : null) ?? checkInOf(o.sourceUrl);
      const past = day !== null && day !== undefined && day < (await today(o.tripId));
      return {
        offerId, title: o.title, priceMinor: o.totalMinor ?? o.priceMinor, currency: o.currency, kind: o.kind as TravelOptionKind, link: ixigoPage(o.sourceUrl),
        ...(day ? { day } : {}), ...(past ? { past: true as const } : {}),
      };
    },
    ...(d.webStays ? { prepare: d.webStays.prepare } : {}),
    ...(d.simulate ? { simulate: d.simulate } : {}),
  };
}

/**
 * An option's Details as a person opens them (the Server team's rev 5, R9: get_option_details, answered in 3 s): what its
 * card carries, and for a stay more, from the search that found it and from its own page and reviews as Go has read them
 * (hotels.details, hotels.reviews). Nothing is read while the person waits: what Go hasn't read yet is read in the
 * background, and the answer says it is partial (complete: false), so the Server asks again rather than keeping it.
 */
import type { ToGoHandler } from '../door/handlers.js';
import type { ToGoResult } from '../door/methods.js';
import { SocketCallError } from '../door/rpc.js';
import type { Engine } from './book/engine.js';
import { clip, ixigoPage } from './cards.js';
import type { ResultOption, ResultsStore } from './results.js';
import { stayRoomFields } from './rooms.js';
import { stayOf } from './web-stays.js';

/** The Details the contract takes (OptionFullDetails). */
type Details = ToGoResult<'get_option_details'>;

/** How long a read still running may take before the answer goes without it: inside the Server's 3 s, with room. */
export const KEPT_WAIT_MS = 1_200;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** ixigo's review month ("Sep 2026") as the contract writes it ("2026-09"); a full date as it is; null otherwise. */
export function reviewDate(when: unknown): string | null {
  if (typeof when !== 'string') return null;
  const t = when.trim();
  if (/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(t)) return t;
  const m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/.exec(t);
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  return m && month >= 0 ? `${m[2]}-${String(month + 1).padStart(2, '0')}` : null;
}

/** A time of day as the contract writes it ("14:00"), from ixigo's ("14:00", "2 PM", "12:30 pm"); null otherwise. */
export function clockOf(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(t.trim());
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? clip(v.trim(), max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : null);

/** The rows of a facts answer kept for the stay's page, by either way Go names it; null when none is kept in time. */
async function keptRows(engine: Pick<Engine, 'peek'>, id: string, pages: string[]): Promise<Array<Record<string, unknown>> | null> {
  for (const page of pages) {
    const hit = engine.peek(id, { hotel: page });
    if (!hit) continue;
    const answer = await Promise.race([hit.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), KEPT_WAIT_MS).unref())]);
    if (answer?.as === 'facts') return answer.rows;
  }
  return null;
}

/** A stay's page read into the Details' own fields: times, rules, nearby with distances, rooms, where it is. */
function fromPage(row: Record<string, unknown>, nights: number | null, people: string[]): Partial<Details> {
  const lat = num(row['lat']);
  const lng = num(row['lng']);
  const stars = num(row['stars']);
  const rules = (Array.isArray(row['house_rules']) ? row['house_rules'] : []).flatMap((r) => text(r, 200) ?? []).slice(0, 20);
  const seen = new Set<string>();
  const nearby = (Array.isArray(row['nearby_list']) ? row['nearby_list'] : []).flatMap((entry) => {
    const n = (entry ?? {}) as Record<string, unknown>;
    const name = text(n['name'], 120);
    if (!name || seen.has(name.toLowerCase())) return [];
    seen.add(name.toLowerCase());
    const d = num(n['distance']);
    const m = d === null ? null : n['unit'] === 'km' ? Math.round(d * 1000) : n['unit'] === 'm' ? Math.round(d) : null;
    return [{ name, ...(m !== null ? { distance_m: m } : {}) }];
  }).slice(0, 20);
  const where = [text(row['area'], 120), text(row['town'], 120)].filter((x): x is string => x !== null);
  const rooms = nights ? stayRoomFields(row, people, nights)?.room_types ?? [] : [];
  const checkIn = clockOf(row['check_in_from']);
  const checkOut = clockOf(row['check_out_by']);
  const cancellation = text(row['cancellation'], 200);
  return {
    ...(where.length > 0 ? { address: where.join(', ') } : {}),
    ...(lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { map: { lat, lng } } : {}),
    ...(checkIn ? { check_in: checkIn } : {}),
    ...(checkOut ? { check_out: checkOut } : {}),
    ...(stars !== null && stars <= 7 ? { stars } : {}),
    ...(rules.length > 0 ? { policies: rules } : {}),
    ...(nearby.length > 0 ? { nearby } : {}),
    ...(rooms.length > 0 ? { rooms } : {}),
    ...(cancellation ? { cancellation } : {}),
  };
}

/** A stay's reviews as Go read them, the contract's way: the rating out of 10, what was said, the month, ixigo. */
function reviewsOf(rows: Array<Record<string, unknown>>): NonNullable<Details['reviews']> {
  return rows.flatMap((r) => {
    const said = [text(r['title'], 200), text(r['said'], 1000)].filter((x): x is string => x !== null).join(': ');
    if (!said) return [];
    const rating = num(r['rating_out_of_10']);
    const date = reviewDate(r['when']);
    return [{ text: clip(said, 1000), ...(rating !== null && rating <= 10 ? { rating } : {}), ...(date ? { date } : {}), source: 'ixigo' }];
  }).slice(0, 10);
}

/** What the search that found the stay knows of it: where it is, its kind of place, its stars. */
function fromSearch(o: ResultOption): Partial<Details> {
  const address = text(o.place?.address, 300);
  const lat = num(o.place?.lat);
  const lng = num(o.place?.lng);
  const type = text(o.facts['type'], 40);
  const stars = num(o.facts['stars']);
  return {
    ...(address ? { address } : {}),
    ...(lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { map: { lat, lng } } : {}),
    ...(type ? { property_type: type.toLowerCase() } : {}),
    ...(stars !== null && stars > 0 && stars <= 7 ? { stars } : {}),
  };
}

export function optionDetailsHandler(d: {
  results: Pick<ResultsStore, 'card' | 'offer' | 'get'>;
  engine: Pick<Engine, 'peek' | 'answer'>;
  /** The trip's people, in order, for each room's share (the same rooms the card shows). */
  people: (tripId: string) => Promise<string[]>;
  /** Whether Go reads ixigo.com itself now (ixigo_web): only then is what's missing read in the background. */
  live: () => boolean;
  log?: { warn: (o: object, msg: string) => void };
}): ToGoHandler<'get_option_details'> {
  return async (p) => {
    const row = await d.results.card(p.trip_id, p.card_id);
    const option = row?.card.options.find((o) => o.option_id === p.option_id);
    if (!row || !option) throw new SocketCallError(404, 'Go has no such option on that card.', 'not_found');
    const offer = await d.results.offer(p.option_id);
    const url = ixigoPage(offer?.sourceUrl ?? null);
    // What the card carries, its labelled photos as its gallery once its page was read.
    const gallery = option.photos?.length ? { gallery_urls: option.photos.map((ph) => ph.url).slice(0, 12) } : {};
    const card: Details = { ...(option.details ?? {}), ...gallery, ...(url?.startsWith('https://') ? { url } : {}) };
    if (offer?.kind !== 'stay' || !url) return card;
    const saved = (await d.results.get(p.trip_id, offer.resultsId))?.options[offer.n - 1] ?? null;
    const pages = [...new Set([url, offer.sourceUrl].filter((x): x is string => typeof x === 'string'))];
    const [page, reviews] = await Promise.all([keptRows(d.engine, 'hotels.details', pages), keptRows(d.engine, 'hotels.reviews', pages)]);
    const nights = stayOf(url)?.nights ?? null;
    const people = page ? await d.people(p.trip_id).catch(() => []) : [];
    const said = reviews ? reviewsOf(reviews) : [];
    const answer: Details = {
      ...card,
      ...(saved ? fromSearch(saved) : {}),
      ...(page?.[0] ? fromPage(page[0], nights, people) : {}),
      // The card's own rooms, once its page was read for them (pick-photos.ts): the same shares the vote shows.
      ...(option.room_types?.length ? { rooms: option.room_types.slice(0, 10) } : {}),
      ...(said.length > 0 ? { reviews: said } : {}),
      ...(page && reviews ? {} : { complete: false }),
    };
    // What isn't read yet is read now, in the background, for the Server's next ask (the room never waits on it).
    if (d.live()) {
      for (const [id, got] of [['hotels.details', page], ['hotels.reviews', reviews]] as const) {
        if (got) continue;
        void d.engine.answer(id, { hotel: url }, { tripId: p.trip_id, background: true }).catch((err: unknown) => {
          d.log?.warn({ tripId: p.trip_id, recipe: id, err: String(err).slice(0, 200) }, "travel: a stay's Details read didn't come back");
        });
      }
    }
    return answer;
  };
}


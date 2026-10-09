/**
 * Constraints people gave as arguments (times, price, rating, head count, non-stop), applied in code to what the backend
 * found: the model is never trusted to drop an option on them itself. What a site filtered is the site's, and anything
 * else asked (wants) the model picks from the results. Journeys sort by departure, stays by rating then price.
 */
import { arrivalWords, daysLater, formatClock, formatInr, localClock } from './cards.js';
import type { TravelKind, TravelOption, TravelQuery } from './travel.js';

const per = (kind: TravelKind): string => (kind === 'stays' ? ' a night' : ' a person');

/** Each constraint this option does not meet, in plain words ("no pool", "₹12,200 a night, over ₹10,000"); none means it fits. */
export function misses(kind: TravelKind, q: TravelQuery, o: TravelOption): string[] {
  const out: string[] = [];
  const j = o.journey;
  const leaves = j ? formatClock(localClock(j.depart_at)) : null;
  if (q.departAfter && (!j || localClock(j.depart_at) < q.departAfter)) out.push(leaves ? `leaves at ${leaves}, before ${formatClock(q.departAfter)}` : 'no departure time');
  if (q.departBefore && (!j || localClock(j.depart_at) > q.departBefore)) out.push(leaves ? `leaves at ${leaves}, after ${formatClock(q.departBefore)}` : 'no departure time');
  if (q.arriveBefore && (!j || daysLater(j.depart_at, j.arrive_at) > 0 || localClock(j.arrive_at) > q.arriveBefore)) {
    out.push(j ? `arrives at ${formatClock(localClock(j.arrive_at))}${arrivalWords(j.depart_at, j.arrive_at, 'the next day')}, after ${formatClock(q.arriveBefore)}` : 'no arrival time');
  }
  if (q.maxPriceMinor !== undefined && o.priceMinor > q.maxPriceMinor) out.push(`${formatInr(o.priceMinor)}${per(kind)}, over ${formatInr(q.maxPriceMinor)}`);
  if (q.minRating !== undefined && (o.rating ?? 0) < q.minRating) out.push(o.rating === undefined ? 'no rating' : `rated ${o.rating}, under ${q.minRating}`);
  if (kind === 'stays' && q.guests !== undefined && typeof o.facts.sleeps === 'number' && o.facts.sleeps < q.guests) out.push(`sleeps ${o.facts.sleeps}, fewer than ${q.guests}`);
  if (q.nonStop && o.journey?.stops !== 0) out.push('not non-stop');
  return out;
}

/** What the people asked for, in plain words, as a search result says it back ("with a pool", "at most ₹10,000 a night"). */
export function asked(kind: TravelKind, q: TravelQuery): string[] {
  const out: string[] = [];
  if (q.departAfter) out.push(`leaving after ${formatClock(q.departAfter)}`);
  if (q.departBefore) out.push(`leaving before ${formatClock(q.departBefore)}`);
  if (q.arriveBefore) out.push(`arriving by ${formatClock(q.arriveBefore)}`);
  if (q.maxPriceMinor !== undefined) out.push(`at most ${formatInr(q.maxPriceMinor)}${per(kind)}`);
  if (q.minRating !== undefined) out.push(`rated ${q.minRating} or more`);
  if (kind === 'stays' && q.guests !== undefined) out.push(`sleeping ${q.guests}`);
  if (q.nonStop) out.push('non-stop');
  // The site's own filters and sort, by their names on its list: ixigo applied them, not Go.
  for (const f of q.siteFilters ?? []) out.push(`${f} (ixigo's filter)`);
  if (q.siteSort) out.push(`sorted by ${q.siteSort} on ixigo`);
  return out;
}

const keeps = (kind: TravelKind, q: TravelQuery, o: TravelOption): boolean => misses(kind, q, o).length === 0;

/** A region, not one area: the best stays should come from across it. */
const REGION = /^(north |south )?goa$/;
/** A good stay, out of 5: what the spread puts up front. */
const GOOD_RATING = 4;

/**
 * For a region ("North Goa"), the best stays spread across its areas: the best good one in each area first, in rating
 * order, then each area's second, then the rest. So the top three are three areas, not one strip. A stay with no
 * area, or not rated good, keeps its place after them.
 */
function spreadAcrossAreas(sorted: TravelOption[]): TravelOption[] {
  const areaOf = (o: TravelOption): string | null => (typeof o.facts.area === 'string' ? o.facts.area.trim().toLowerCase() : null);
  const good = sorted.filter((o) => areaOf(o) !== null && (o.rating ?? 0) >= GOOD_RATING);
  const taken = new Set<TravelOption>();
  const up: TravelOption[] = [];
  for (const round of [1, 2]) {
    const seen = new Map<string, number>();
    for (const o of good) {
      const n = (seen.get(areaOf(o)!) ?? 0) + 1;
      seen.set(areaOf(o)!, n);
      if (n === round) {
        up.push(o);
        taken.add(o);
      }
    }
  }
  return [...up, ...sorted.filter((o) => !taken.has(o))];
}

/** When nothing fits: the option that misses the fewest constraints (then the cheapest), and what it misses. */
export function closest(kind: TravelKind, q: TravelQuery, options: TravelOption[]): { option: TravelOption; misses: string[] } | null {
  let best: { option: TravelOption; misses: string[] } | null = null;
  for (const option of options) {
    const m = misses(kind, q, option);
    if (!best || m.length < best.misses.length || (m.length === best.misses.length && option.priceMinor < best.option.priceMinor)) best = { option, misses: m };
  }
  return best;
}

/** keepOrder: the site sorted them as the ask asked (its own sort): Go keeps that order. */
export function applyConstraints(kind: TravelKind, q: TravelQuery, options: TravelOption[], o: { keepOrder?: boolean } = {}): TravelOption[] {
  const kept = options.filter((option) => keeps(kind, q, option));
  if (o.keepOrder) return kept;
  if (kind === 'stays') {
    const best = kept.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.priceMinor - b.priceMinor);
    return REGION.test((q.area ?? '').trim().toLowerCase()) ? spreadAcrossAreas(best) : best;
  }
  return kept.sort((a, b) => (a.journey?.depart_at ?? '').localeCompare(b.journey?.depart_at ?? '') || a.priceMinor - b.priceMinor);
}

/**
 * Constraints people gave, applied in code to what the backend found. The model passes them as arguments; it is never
 * trusted to drop an option itself. Journeys sort by departure, stays by rating then price.
 */
import { arrivalWords, daysLater, formatClock, formatInr, localClock } from './cards.js';
import type { TravelKind, TravelOption, TravelQuery } from './travel.js';

/** "Near the beach" means this many minutes or less. */
const BEACH_NEAR_MINUTES = 10;

type MustHave = NonNullable<TravelQuery['mustHave']>[number];

function has(o: TravelOption, need: MustHave): boolean {
  switch (need) {
    case 'pool':
      return o.facts.pool === true;
    case 'beach':
      return typeof o.facts.beach_minutes === 'number' && o.facts.beach_minutes <= BEACH_NEAR_MINUTES;
    case 'breakfast':
      return o.facts.breakfast === true;
    case 'free_cancellation':
      // A date when the backend gives one; ixigo's hotel list says "Free Cancellation" without it.
      return o.refundableUntil !== undefined || o.facts.free_cancellation === true;
    case 'non_stop':
      return o.journey?.stops === 0;
  }
}

const per = (kind: TravelKind): string => (kind === 'stays' ? ' a night' : ' a person');

/**
 * Each person's share of a stay, to the rupee: its whole stay over the head count it was priced for (the search's own),
 * or null. Said in words ("₹14,366 each"), never in paise (staging, 10 Oct: "₹14,366.40 each for the stay").
 */
export function shareOf(o: { totalMinor?: number; facts: Record<string, string | number | boolean> }, q: Pick<TravelQuery, 'guests'>): number | null {
  const guests = typeof o.facts['guests'] === 'number' ? o.facts['guests'] : q.guests;
  return o.totalMinor !== undefined && guests !== undefined && guests > 0 ? Math.round(o.totalMinor / guests / 100) * 100 : null;
}

const MISSING: Record<MustHave, string> = {
  pool: 'no pool',
  beach: `not within ${BEACH_NEAR_MINUTES} minutes of the beach`,
  breakfast: 'no breakfast',
  free_cancellation: 'no free cancellation',
  non_stop: 'not non-stop',
};

/**
 * A bus's point the group named, from its points as the recipe reads them ("Majestic; Silk Board; …", the busiest
 * first): the first whose name holds their words or is held in them ("Majestic" and "Majestic- Amar Hotel"), or null.
 */
export function pointAt(points: string, words: string): string | null {
  const w = words.trim().toLowerCase();
  return points.split('; ').find((p) => {
    const name = p.trim().toLowerCase();
    return name !== '' && (name.includes(w) || w.includes(name));
  }) ?? null;
}

/**
 * Whether a journey arrives by a clock time: the first one after it leaves, as people mean "reaches by morning" of a
 * night bus. A bus at 8 pm must arrive by 10 am the next day, one at 6 am by 10 am that day; a 27-hour train misses both
 * (the exam, 10 Oct: "reaches by 10 am" held against the next day dropped every overnight bus, Bengaluru to Goa).
 */
function arrivesBy(j: NonNullable<TravelOption['journey']>, hhmm: string): boolean {
  const day = localClock(j.depart_at) < hhmm ? 0 : 1;
  const later = daysLater(j.depart_at, j.arrive_at);
  return later < day || (later === day && localClock(j.arrive_at) <= hhmm);
}

/** Each constraint this option does not meet, in plain words ("no pool", "₹12,200 a night, over ₹10,000"); none means it fits. */
export function misses(kind: TravelKind, q: TravelQuery, o: TravelOption): string[] {
  const out: string[] = [];
  const j = o.journey;
  const leaves = j ? formatClock(localClock(j.depart_at)) : null;
  if (q.departAfter && (!j || localClock(j.depart_at) < q.departAfter)) out.push(leaves ? `leaves at ${leaves}, before ${formatClock(q.departAfter)}` : 'no departure time');
  if (q.departBefore && (!j || localClock(j.depart_at) > q.departBefore)) out.push(leaves ? `leaves at ${leaves}, after ${formatClock(q.departBefore)}` : 'no departure time');
  if (q.arriveBefore && (!j || !arrivesBy(j, q.arriveBefore))) {
    out.push(j ? `arrives at ${formatClock(localClock(j.arrive_at))}${arrivalWords(j.depart_at, j.arrive_at, 'the next day')}, after ${formatClock(q.arriveBefore)}` : 'no arrival time');
  }
  if (q.maxPriceMinor !== undefined && o.priceMinor > q.maxPriceMinor) out.push(`${formatInr(o.priceMinor)}${per(kind)}, over ${formatInr(q.maxPriceMinor)}`);
  // A share Go cannot work out (no whole stay, no head count) is not held against the stay.
  const cap = kind === 'stays' ? q.maxShareMinor : undefined;
  const share = cap !== undefined ? shareOf(o, q) : null;
  if (cap !== undefined && share !== null && share > cap) out.push(`${formatInr(share)} each for the whole stay, over ${formatInr(cap)} a head`);
  if (q.minRating !== undefined && (o.rating ?? 0) < q.minRating) out.push(o.rating === undefined ? 'no rating' : `rated ${o.rating}, under ${q.minRating}`);
  if (kind === 'stays' && q.guests !== undefined && typeof o.facts.sleeps === 'number' && o.facts.sleeps < q.guests) out.push(`sleeps ${o.facts.sleeps}, fewer than ${q.guests}`);
  for (const need of q.mustHave ?? []) if (!has(o, need)) out.push(MISSING[need]);
  // A bus whose points the site didn't list is not held against it; one that lists them and not this one doesn't fit.
  if (kind === 'buses' && q.boardAt && typeof o.facts.boarding_points === 'string' && !pointAt(o.facts.boarding_points, q.boardAt)) out.push(`no pickup at ${q.boardAt}`);
  if (kind === 'buses' && q.dropAt && typeof o.facts.dropping_points === 'string' && !pointAt(o.facts.dropping_points, q.dropAt)) out.push(`no drop at ${q.dropAt}`);
  return out;
}

/** What the people asked for, in plain words, as a search result says it back ("with a pool", "at most ₹10,000 a night"). */
export function asked(kind: TravelKind, q: TravelQuery): string[] {
  const out: string[] = [];
  if (q.departAfter) out.push(`leaving after ${formatClock(q.departAfter)}`);
  if (q.departBefore) out.push(`leaving before ${formatClock(q.departBefore)}`);
  if (q.arriveBefore) out.push(`arriving by ${formatClock(q.arriveBefore)}`);
  // A time the trip gave, not this ask (a member's own answer), says why with it: "leaving after 6:00 pm, because Rahul
  // can leave Friday after 6 pm" (staging, 9 Oct: a time nobody in the chat had said read as made up).
  if (q.because && out.length > 0) out[out.length - 1] = `${out[out.length - 1]}, because ${q.because.replace(/^(because|as)\s+/i, '').replace(/[.\s]+$/, '')}`;
  if (q.maxPriceMinor !== undefined) out.push(`at most ${formatInr(q.maxPriceMinor)}${per(kind)}`);
  if (kind === 'stays' && q.maxShareMinor !== undefined) out.push(`at most ${formatInr(q.maxShareMinor)} a head for the whole stay`);
  if (q.minRating !== undefined) out.push(`rated ${q.minRating} or more`);
  if (kind === 'stays' && q.guests !== undefined) out.push(`sleeping ${q.guests}`);
  const words: Record<MustHave, string> = {
    pool: 'with a pool',
    beach: `within ${BEACH_NEAR_MINUTES} minutes of the beach`,
    breakfast: 'with breakfast',
    free_cancellation: 'with free cancellation',
    non_stop: 'non-stop',
  };
  for (const need of q.mustHave ?? []) out.push(words[need]);
  if (kind === 'buses' && q.boardAt) out.push(`picking up at ${q.boardAt}`);
  if (kind === 'buses' && q.dropAt) out.push(`dropping at ${q.dropAt}`);
  // The site's own filters and sort, by their names on its list: ixigo applied them, not Go.
  for (const f of q.siteFilters ?? []) out.push(`${f} (ixigo's filter)`);
  if (q.siteSort) out.push(`sorted by ${q.siteSort} on ixigo`);
  return out;
}

const keeps = (kind: TravelKind, q: TravelQuery, o: TravelOption): boolean => misses(kind, q, o).length === 0;

/** The limits Go checks itself (misses), each one alone for missedByAll. */
const LIMITS = ['departAfter', 'departBefore', 'arriveBefore', 'maxPriceMinor', 'maxShareMinor', 'minRating', 'guests', 'boardAt', 'dropAt'] as const;

/**
 * The limits that, each on its own, leave out every option, in asked()'s words ("arriving by 10:00 am"): when nothing
 * fits, the room hears which limit cut them all, never a guess (the exam, 10 Oct: "no AC sleeper" on Bengaluru to Goa,
 * where 46 of 54 buses were AC sleepers and the arrival time had cut every one).
 */
export function missedByAll(kind: TravelKind, q: TravelQuery, options: TravelOption[]): string[] {
  if (options.length === 0) return [];
  const bare: TravelQuery = { ...q };
  for (const k of LIMITS) delete bare[k];
  delete bare.mustHave;
  const alone: TravelQuery[] = [
    ...LIMITS.filter((k) => q[k] !== undefined).map((k) => ({ ...bare, [k]: q[k] }) as TravelQuery),
    ...(q.mustHave ?? []).map((need) => ({ ...bare, mustHave: [need] })),
  ];
  const said = new Set(asked(kind, bare));
  return alone.filter((p) => options.every((o) => !keeps(kind, p, o))).flatMap((p) => asked(kind, p).filter((t) => !said.has(t)));
}

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

/**
 * When nothing fits: the options that miss the fewest constraints (then the cheapest, a stay by its whole stay), at
 * most n, each with what it misses, so the group sees how near it gets.
 */
export function nearest(kind: TravelKind, q: TravelQuery, options: TravelOption[], n = 3): Array<{ option: TravelOption; misses: string[] }> {
  const cost = (o: TravelOption): number => o.totalMinor ?? o.priceMinor;
  return options
    .map((option) => ({ option, misses: misses(kind, q, option) }))
    .sort((a, b) => a.misses.length - b.misses.length || cost(a.option) - cost(b.option))
    .slice(0, n);
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

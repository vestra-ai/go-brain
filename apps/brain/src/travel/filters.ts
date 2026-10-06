/**
 * Constraints people gave, applied in code to what the backend found. The model passes them as arguments; it is never
 * trusted to drop an option itself. Journeys sort by departure, stays by rating then price.
 */
import { formatClock, formatInr, localClock } from './cards.js';
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
      return o.refundableUntil !== undefined;
    case 'non_stop':
      return o.journey?.stops === 0;
  }
}

const per = (kind: TravelKind): string => (kind === 'stays' ? ' a night' : ' a person');

const MISSING: Record<MustHave, string> = {
  pool: 'no pool',
  beach: `not within ${BEACH_NEAR_MINUTES} minutes of the beach`,
  breakfast: 'no breakfast',
  free_cancellation: 'no free cancellation',
  non_stop: 'not non-stop',
};

/** Each constraint this option does not meet, in plain words ("no pool", "₹12,200 a night, over ₹10,000"); none means it fits. */
export function misses(kind: TravelKind, q: TravelQuery, o: TravelOption): string[] {
  const out: string[] = [];
  const j = o.journey;
  const leaves = j ? formatClock(localClock(j.depart_at)) : null;
  if (q.departAfter && (!j || localClock(j.depart_at) < q.departAfter)) out.push(leaves ? `leaves at ${leaves}, before ${formatClock(q.departAfter)}` : 'no departure time');
  if (q.departBefore && (!j || localClock(j.depart_at) > q.departBefore)) out.push(leaves ? `leaves at ${leaves}, after ${formatClock(q.departBefore)}` : 'no departure time');
  if (q.arriveBefore && (!j || j.arrive_at.slice(0, 10) !== j.depart_at.slice(0, 10) || localClock(j.arrive_at) > q.arriveBefore)) {
    out.push(j ? `arrives at ${formatClock(localClock(j.arrive_at))}${j.arrive_at.slice(0, 10) !== j.depart_at.slice(0, 10) ? ' the next day' : ''}, after ${formatClock(q.arriveBefore)}` : 'no arrival time');
  }
  if (q.maxPriceMinor !== undefined && o.priceMinor > q.maxPriceMinor) out.push(`${formatInr(o.priceMinor)}${per(kind)}, over ${formatInr(q.maxPriceMinor)}`);
  if (q.minRating !== undefined && (o.rating ?? 0) < q.minRating) out.push(o.rating === undefined ? 'no rating' : `rated ${o.rating}, under ${q.minRating}`);
  if (kind === 'stays' && q.guests !== undefined && typeof o.facts.sleeps === 'number' && o.facts.sleeps < q.guests) out.push(`sleeps ${o.facts.sleeps}, fewer than ${q.guests}`);
  for (const need of q.mustHave ?? []) if (!has(o, need)) out.push(MISSING[need]);
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
  const words: Record<MustHave, string> = {
    pool: 'with a pool',
    beach: `within ${BEACH_NEAR_MINUTES} minutes of the beach`,
    breakfast: 'with breakfast',
    free_cancellation: 'with free cancellation',
    non_stop: 'non-stop',
  };
  for (const need of q.mustHave ?? []) out.push(words[need]);
  return out;
}

const keeps = (kind: TravelKind, q: TravelQuery, o: TravelOption): boolean => misses(kind, q, o).length === 0;

/** When nothing fits: the option that misses the fewest constraints (then the cheapest), and what it misses. */
export function closest(kind: TravelKind, q: TravelQuery, options: TravelOption[]): { option: TravelOption; misses: string[] } | null {
  let best: { option: TravelOption; misses: string[] } | null = null;
  for (const option of options) {
    const m = misses(kind, q, option);
    if (!best || m.length < best.misses.length || (m.length === best.misses.length && option.priceMinor < best.option.priceMinor)) best = { option, misses: m };
  }
  return best;
}

export function applyConstraints(kind: TravelKind, q: TravelQuery, options: TravelOption[]): TravelOption[] {
  const kept = options.filter((o) => keeps(kind, q, o));
  if (kind === 'stays') return kept.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.priceMinor - b.priceMinor);
  return kept.sort((a, b) => (a.journey?.depart_at ?? '').localeCompare(b.journey?.depart_at ?? '') || a.priceMinor - b.priceMinor);
}

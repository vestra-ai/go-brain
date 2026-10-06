/**
 * Constraints people gave, applied in code to what the backend found. The model passes them as arguments; it is never
 * trusted to drop an option itself. Journeys sort by departure, stays by rating then price.
 */
import { localClock } from './cards.js';
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

function keeps(kind: TravelKind, q: TravelQuery, o: TravelOption): boolean {
  const j = o.journey;
  if (q.departAfter && (!j || localClock(j.depart_at) < q.departAfter)) return false;
  if (q.departBefore && (!j || localClock(j.depart_at) > q.departBefore)) return false;
  if (q.arriveBefore && (!j || j.arrive_at.slice(0, 10) !== j.depart_at.slice(0, 10) || localClock(j.arrive_at) > q.arriveBefore)) return false;
  if (q.maxPriceMinor !== undefined && o.priceMinor > q.maxPriceMinor) return false;
  if (q.minRating !== undefined && (o.rating ?? 0) < q.minRating) return false;
  if (kind === 'stays' && q.guests !== undefined && typeof o.facts.sleeps === 'number' && o.facts.sleeps < q.guests) return false;
  return (q.mustHave ?? []).every((need) => has(o, need));
}

export function applyConstraints(kind: TravelKind, q: TravelQuery, options: TravelOption[]): TravelOption[] {
  const kept = options.filter((o) => keeps(kind, q, o));
  if (kind === 'stays') return kept.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.priceMinor - b.priceMinor);
  return kept.sort((a, b) => (a.journey?.depart_at ?? '').localeCompare(b.journey?.depart_at ?? '') || a.priceMinor - b.priceMinor);
}

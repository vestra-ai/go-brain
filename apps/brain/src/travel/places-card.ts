/**
 * "Where should we go" as its own card (the Server team's rev 5, R2). ixigo's trip explorer's places (plan.explore) are
 * saved as results of kind place, so show_options puts them up as it does a search's: each with ixigo's estimate a person
 * for the trip, why it may fit and getting there. The card's first three then get their own place from ixigo in the
 * background, never while the room waits: where it is with 6 to 12 labelled photos (travel.placeFor), and its best time
 * to go and the places to visit there (plan.destination, kept by placeFor's own read).
 */
import type { TurnCard } from '../composer/context.js';
import type { ServerLink } from '../door/server-link.js';
import type { TripPack } from '../trips/pack.js';
import type { Saved, TripChange } from '../trips/save-trip.js';
import type { Engine } from './book/engine.js';
import { clip, formatInr } from './cards.js';
import type { OptionDetailsT } from './details.js';
import { stableId } from './ids.js';
import { POSTED_WAIT_MS } from './pick-photos.js';
import type { ResultOption, ResultsStore } from './results.js';
import type { PlaceFor } from './place-for.js';

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const words = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => text(x) ?? []) : []);
const upper = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

/** Each place the explorer read, as an option of kind place: ixigo's estimate a person for the trip, why, getting there. */
export function placeOptions(rows: Array<Record<string, unknown>>): ResultOption[] {
  return rows.flatMap((r): ResultOption[] => {
    const name = text(r['place']);
    if (!name) return [];
    const estimate = num(r['estimate_minor']);
    const nights = num(r['estimate_nights']);
    const kinds = words(r['kind']);
    const tag = text(r['tag']);
    const facts: Record<string, string | number> = {};
    const there = num(r['getting_there_minor']);
    if (there) facts['getting_there_minor'] = there;
    if (nights) facts['nights'] = nights;
    for (const k of ['stay_a_night', 'weather', 'guide'] as const) {
      const v = text(r[k]);
      if (v) facts[k] = v;
    }
    if (kinds.length > 0) facts['kinds'] = kinds.join(', ');
    const goodFor = words(r['good_for']);
    if (goodFor.length > 0) facts['good_for'] = goodFor.join(', ');
    return [{
      kind: 'place',
      title: clip(name, 80),
      ...(estimate ? { priceMinor: estimate, currency: 'INR', priceNote: nights ? `a person, ${nights} nights` : 'a person' } : {}),
      highlights: [...(tag ? [tag] : []), ...kinds.map(upper)].map((h) => clip(h, 40)).slice(0, 4),
      facts,
      place: { name: clip(name, 120) },
    }];
  });
}

/** A place's sheet from what the explorer said: why it may fit, and what getting there and a stay cost, as ixigo guesses. */
export function placeDetails(o: ResultOption): OptionDetailsT | null {
  const f = o.facts;
  const kinds = text(f['kinds']);
  const goodFor = text(f['good_for']);
  const weather = text(f['weather']);
  const why = [
    kinds ? upper(kinds) : null,
    goodFor ? `Good for ${goodFor}` : null,
    weather ? `${weather} then` : null,
  ].filter((x): x is string => x !== null).map((w) => clip(w, 140));
  const there = num(f['getting_there_minor']);
  const night = text(f['stay_a_night']);
  const nights = num(f['nights']);
  const facts = [
    ...(there ? [{ label: 'Getting there', value: `from ${formatInr(there)} a person` }] : []),
    ...(night ? [{ label: "A night's stay", value: night }] : []),
    ...(o.priceMinor !== undefined ? [{ label: 'The trip', value: `about ${formatInr(o.priceMinor)} a person${nights ? ` for ${nights} nights` : ''}, ixigo's estimate` }] : []),
  ].map((x) => ({ label: x.label, value: clip(x.value, 200) }));
  if (why.length === 0 && facts.length === 0) return null;
  return { ...(why.length ? { why: why.slice(0, 5) } : {}), ...(facts.length ? { facts } : {}) };
}

/** A place's own guide read (plan.destination): its best time to go, and the places to visit there by name. */
function fromGuide(row: Record<string, unknown> | undefined): { best: string | null; visit: string[] } {
  if (!row) return { best: null, visit: [] };
  const visit = words(row['places_to_visit']).map((v) => clip(v.split(/\s\(|:\s/)[0]!.trim(), 60)).filter((v) => v.length > 0);
  return { best: text(row['best_time']), visit: [...new Set(visit)].slice(0, 20) };
}

/**
 * The card's first places, one at a time in the background: each one's own place from ixigo (where it is, its photos)
 * and its guide's best time and places to visit, onto its option; the card is replaced once it has been posted.
 */
export async function showPlaces(
  d: {
    placeFor: PlaceFor | null;
    engine: Pick<Engine, 'answer'>;
    results: Pick<ResultsStore, 'card' | 'setOptionFields'>;
    link: Pick<ServerLink, 'request'>;
    posted?: (tripId: string, cardId: string, withinMs: number) => Promise<boolean>;
    log?: { warn: (o: object, msg: string) => void };
  },
  tripId: string,
  picks: Array<{ cardId: string; optionId: string; name: string }>,
): Promise<void> {
  for (const pick of picks) {
    try {
      const found = d.placeFor ? await d.placeFor(pick.name, { tripId }).catch(() => null) : null;
      const guide = await d.engine.answer('plan.destination', { place: pick.name }, { tripId, background: true }).catch(() => null);
      const { best, visit } = fromGuide(guide?.as === 'facts' ? guide.rows[0] : undefined);
      const option = (await d.results.card(tripId, pick.cardId))?.card.options.find((o) => o.option_id === pick.optionId);
      if (!option) continue;
      const facts = [...(option.details?.facts ?? []), ...(best ? [{ label: 'Best time to go', value: clip(best, 200) }] : [])].slice(0, 20);
      const details = best || visit.length > 0 ? { ...(option.details ?? {}), ...(facts.length ? { facts } : {}), ...(visit.length ? { activities: visit } : {}) } : null;
      const place = found?.place ?? null;
      const fields = {
        ...(place ? { place: { ...place, name: clip(place.name, 120) } } : {}),
        ...(place?.photos?.length ? { photos: place.photos.slice(0, 12) } : {}),
        ...(place?.photo_url && !option.image_url ? { image_url: place.photo_url } : {}),
        ...(details ? { details } : {}),
      };
      if (Object.keys(fields).length === 0) continue;
      const card = await d.results.setOptionFields(tripId, pick.cardId, pick.optionId, fields);
      if (!card) continue;
      if (d.posted && !(await d.posted(tripId, pick.cardId, POSTED_WAIT_MS))) return;
      await d.link.request('replace_card', { trip_id: tripId, card });
    } catch (err) {
      d.log?.warn({ tripId, err: String(err).slice(0, 200) }, "travel: a place's own photos didn't reach its card");
    }
  }
}

/**
 * A trip's title after its place changes: the old place's name in it swapped for the new one's ("Manali trip" becomes
 * "Goa trip"), a trip with none "<place> trip"; null to leave a title of the group's own ("Rahul's 30th") as it is.
 */
export function retitled(title: string | null | undefined, old: string | null | undefined, place: string): string | null {
  const short = (p: string): string => p.split(',')[0]!.trim();
  const now = short(place);
  if (!title?.trim()) return `${now} trip`;
  const was = old ? short(old) : '';
  if (!was || was.toLowerCase() === now.toLowerCase()) return null;
  const at = title.toLowerCase().indexOf(was.toLowerCase());
  return at < 0 ? null : clip(`${title.slice(0, at)}${now}${title.slice(at + was.length)}`, 80);
}

/**
 * A place a vote picked (rev 5 R2): the trip's destination becomes it, through the trip's one writer (save-trip.ts, which
 * resolves it to ixigo's place with its photos), and its title follows when it named the old place. On the turn the
 * vote's close woke, beside the rooms card's; it posts no card of its own.
 */
export function placeOnClose(d: {
  results: Pick<ResultsStore, 'offer'>;
  save: (pack: TripPack, change: TripChange, requestId: () => string) => Promise<Saved>;
  log?: { warn: (o: object, msg: string) => void };
}): TurnCard {
  return async ({ tripId, wake, pack }) => {
    const closed = wake.find((w) => w.kind === 'trip_change' && (w.payload as { type?: string } | null)?.type === 'decision.closed');
    const decisionId = (closed?.payload as { decisionId?: string } | undefined)?.decisionId;
    const decision = decisionId ? pack.trip.decisions.find((x) => x.decision_id === decisionId) : undefined;
    if (!decision || decision.kind !== 'choice' || decision.result_index == null) return null;
    const won = decision.options[decision.result_index];
    const offer = won?.option_ref ? await d.results.offer(won.option_ref) : null;
    if (!offer || offer.kind !== 'place') return null;
    const title = retitled(pack.trip.title, pack.trip.destination?.name ?? null, offer.title);
    const saved = await d.save(pack, { destination: offer.title, ...(title ? { title } : {}) }, () => stableId('go_trip', tripId, decision.decision_id)).catch((err: unknown) => {
      d.log?.warn({ tripId, err: String(err).slice(0, 200) }, "travel: a place the vote picked didn't become the trip's");
      return null;
    });
    if (saved && !saved.ok) d.log?.warn({ tripId, error: saved.error }, "travel: a place the vote picked didn't become the trip's");
    return null;
  };
}

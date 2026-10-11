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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ixigo's two-word kinds of place (its destinationType, lowercased) as a person says them; any other as it is. */
const KIND_WORDS: Record<string, string> = {
  'nature wildlife': 'nature and wildlife', 'food drink': 'food and drink', 'relaxation wellness': 'wellness',
  'festivals events': 'festivals', 'sports recreation': 'sports',
};
const kindWords = (k: string): string => KIND_WORDS[k.toLowerCase()] ?? k.toLowerCase();

/** What the explorer was asked, for each place's words: where from, the month, and the group's budget a head. */
export interface ExploreAsk {
  /** The city as the group wrote it ("Bengaluru"). */
  origin?: string | null;
  /** Any day in the month, YYYY-MM-DD. */
  month?: string | null;
  /** The group's budget a head for the whole trip, in paise: the only budget ixigo's estimate is weighed against. */
  budgetMinor?: number | null;
}

/**
 * The line the App draws in green on a place and first under "Why Go picked it": the group's budget it fits, and the
 * month as ixigo's explorer reads it. Only what ixigo said and the group decided; null when there is neither.
 */
function fitLine(r: Record<string, unknown>, asked: ExploreAsk): string | null {
  const estimate = num(r['estimate_minor']);
  const budget = num(asked.budgetMinor);
  const fits = estimate && budget && estimate <= budget ? `Fits the ${formatInr(budget)} budget` : null;
  const at = /^\d{4}-(\d{2})-\d{2}$/.exec(asked.month ?? '');
  const month = at ? MONTHS[Number(at[1]) - 1] : undefined;
  const weather = text(r['weather']);
  const tags = words(r['weather_tags']).map((t) => t.toLowerCase());
  const sky = tags.includes('no rain') ? 'dry' : tags.includes('rain') ? 'some rain' : null;
  const then = month && (weather || sky) ? upper(`${[sky, weather].filter(Boolean).join(', ')} in ${month}`) : null;
  const line = [fits, then].filter((x): x is string => x !== null).join(' · ');
  return line ? clip(line, 140) : null;
}

/**
 * Each place the explorer read, as an option of kind place, drawn as the App's place card: ixigo's estimate a person for
 * the trip, its kind and what getting there costs (the tagline), the fit line, and its photo. A number ixigo didn't give
 * is left out, never guessed: the explorer has no travel time, so the tagline has none.
 */
export function placeOptions(rows: Array<Record<string, unknown>>, asked: ExploreAsk = {}): ResultOption[] {
  return rows.flatMap((r): ResultOption[] => {
    const name = text(r['place']);
    if (!name) return [];
    const estimate = num(r['estimate_minor']);
    const nights = num(r['estimate_nights']);
    const kinds = words(r['kind']).map(kindWords);
    const tag = text(r['tag']);
    const facts: Record<string, string | number> = {};
    const there = num(r['getting_there_minor']);
    if (there) facts['getting_there_minor'] = there;
    if (nights) facts['nights'] = nights;
    for (const k of ['stay_a_night', 'weather', 'guide', 'tag'] as const) {
      const v = text(r[k]);
      if (v) facts[k] = v;
    }
    if (kinds.length > 0) facts['kinds'] = kinds.join(', ');
    const goodFor = words(r['good_for']);
    if (goodFor.length > 0) facts['good_for'] = goodFor.join(', ');
    const fit = fitLine(r, asked);
    if (fit) facts['fit'] = fit;
    const origin = text(asked.origin);
    if (origin) facts['origin'] = clip(origin, 60);
    const tagline = [kinds[0] ? upper(kinds[0]) : null, there ? `getting there from ${formatInr(there)}` : null].filter((x): x is string => x !== null).join(' · ');
    const photo = words(r['photo_list'])[0];
    return [{
      kind: 'place',
      title: clip(name, 80),
      ...(tagline ? { subtitle: clip(tagline, 120) } : {}),
      ...(estimate ? { priceMinor: estimate, currency: 'INR', priceNote: nights ? `a person, ${nights} nights` : 'a person' } : {}),
      highlights: [...(tag ? [tag] : []), ...kinds.map(upper)].map((h) => clip(h, 40)).slice(0, 4),
      facts,
      ...(photo?.startsWith('https://') ? { imageUrl: photo } : {}),
      place: { name: clip(name, 120) },
    }];
  });
}

/** A place Go picked itself for where the trip could go (suggest_places), as the model gives it. */
export interface SuggestedPlace {
  name: string;
  /** The town the group would travel to and stay in (Madikeri for Coorg): the trip's place when the vote's pick can't be. */
  stay_in: string;
  kind: string;
  travel: string;
  fit: string;
  why: string[];
  cost_each_rupees: number;
  nights?: number | undefined;
  things_to_do: string[];
}

/** The world's countries by their English names, from the runtime's own region names (no list of Go's). */
const COUNTRIES: ReadonlySet<string> = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const out = new Set<string>();
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      try {
        const name = names.of(code);
        if (name && name !== code && name !== 'Unknown Region') out.add(name.toLowerCase());
      } catch {
        // Not a region code.
      }
    }
  }
  return out;
})();
/** A city that is its own country, a trip's place all the same. */
const CITY_STATES = new Set(['singapore', 'hong kong', 'macao', 'macau', 'monaco', 'vatican city', 'san marino']);

/** A country alone ("Vietnam", "Morocco"), never a place in one ("Hoi An, Vietnam") or a city that is its own country. */
export function isCountry(name: string): boolean {
  const t = name.trim().toLowerCase();
  return !t.includes(',') && COUNTRIES.has(t) && !CITY_STATES.has(t);
}

/** One line of a place's list kept in its facts (facts take no lists): its items with this between them. */
const SEP = ' | ';
const listOf = (v: unknown): string[] => (typeof v === 'string' && v !== '' ? v.split(SEP).map((x) => x.trim()).filter((x) => x !== '') : []);
const itemsOf = (xs: string[], max: number): string => xs.map((x) => clip(x.replace(/\|/g, '/').trim(), max)).filter((x) => x !== '').join(SEP);

/**
 * The places Go picked itself, as options of kind place drawn as the App's place card (Keshav, 11 Oct: suggestions need
 * no ixigo): the tagline (its kind and rough travel time from the asker's city), its cost a person as Go's rough
 * estimate (facts.estimate: the card says so), and the fit line, reasons and things to do for its Details. Its guide's
 * name is the place before its first comma, for its guide's best time and places to visit in the background.
 */
export function suggestedPlaces(places: SuggestedPlace[]): ResultOption[] {
  return places.map((p) => {
    // A country alone is no place a trip is set to: its town first ("Hanoi, Vietnam").
    const stayIn = p.stay_in.trim();
    const name = clip(isCountry(p.name) && stayIn && !isCountry(stayIn) ? `${stayIn}, ${p.name.trim()}` : p.name.trim(), 80);
    return {
      kind: 'place',
      title: name,
      subtitle: clip(`${p.kind.trim()} · ${p.travel.trim()}`, 120),
      priceMinor: Math.round(p.cost_each_rupees) * 100,
      currency: 'INR',
      priceNote: 'each, rough',
      highlights: [clip(p.kind.trim(), 40)],
      facts: {
        estimate: true,
        fit: clip(p.fit.trim(), 140),
        why: itemsOf(p.why.slice(0, 4), 140),
        things: itemsOf(p.things_to_do.slice(0, 6), 60),
        ...(p.nights ? { nights: p.nights } : {}),
        guide: name.split(',')[0]!.trim(),
        ...(stayIn ? { stay_in: clip(stayIn, 60) } : {}),
      },
      place: { name },
    };
  });
}

/** A place Go picked itself, its Details: the fit line first, its reasons, its rough cost as an estimate, things to do. */
function suggestedDetails(o: ResultOption): OptionDetailsT {
  const f = o.facts;
  const nights = num(f['nights']);
  const why = [text(f['fit']), ...listOf(f['why'])].filter((x): x is string => x !== null).slice(0, 5);
  const things = listOf(f['things']).slice(0, 20);
  const cost = o.priceMinor;
  return {
    ...(why.length ? { why } : {}),
    ...(cost !== undefined
      ? {
          costs: [{ label: nights ? `Getting there and ${nights} nights` : 'Getting there and the stay', emoji: '🧳', amount_minor: cost, currency: 'INR' }],
          total_minor: cost,
          caption: `Go's rough estimate, not a price: about ${formatInr(cost)} each`,
        }
      : {}),
    ...(things.length ? { activities: things } : {}),
  };
}

/** ixigo's "about ₹2,000" a night, in paise; null when it says no amount. */
function nightMinor(night: string | null): number | null {
  const m = night ? /₹\s*([\d,]+)/.exec(night) : null;
  const rupees = m ? Number(m[1]!.replace(/,/g, '')) : NaN;
  return Number.isFinite(rupees) && rupees > 0 ? rupees * 100 : null;
}

/**
 * A place's sheet as the App's Details draws it, from what the explorer said: why it may fit (the fit line first), the
 * rough cost each (a night's stay and getting there, as ixigo prices them, and ixigo's own estimate for the trip as the
 * total), and the caption that says what that total covers. Things to do come from its guide (showPlaces, Details).
 */
export function placeDetails(o: ResultOption): OptionDetailsT | null {
  if (o.facts['estimate'] === true) return suggestedDetails(o);
  const f = o.facts;
  const kinds = text(f['kinds']);
  const goodFor = text(f['good_for']);
  const why = [
    text(f['fit']),
    kinds ? upper(kinds) : null,
    goodFor ? `Good for ${goodFor}` : null,
    text(f['tag']),
  ].filter((x): x is string => x !== null).map((w) => clip(w, 140));
  const there = num(f['getting_there_minor']);
  const night = nightMinor(text(f['stay_a_night']));
  const nights = num(f['nights']);
  const origin = text(f['origin']);
  const costs = [
    ...(night ? [{ label: 'Stay, a night', emoji: '🏡', amount_minor: night, currency: 'INR' }] : []),
    ...(there ? [{ label: 'Getting there, from', emoji: '🎫', amount_minor: there, currency: 'INR' }] : []),
  ];
  const caption = o.priceMinor !== undefined
    ? `ixigo's estimate${nights ? ` for ${nights} nights` : ''}${origin ? ` from ${origin}` : ''}: about ${formatInr(o.priceMinor)} each`
    : null;
  if (why.length === 0 && costs.length === 0 && !caption) return null;
  return {
    ...(why.length ? { why: why.slice(0, 5) } : {}),
    ...(costs.length ? { costs } : {}),
    ...(o.priceMinor !== undefined && costs.length ? { total_minor: o.priceMinor } : {}),
    ...(caption ? { caption: clip(caption, 200) } : {}),
  };
}

/** A place's own guide read (plan.destination): its best time to go, and the places to visit there by name. */
export function fromGuide(row: Record<string, unknown> | undefined): { best: string | null; visit: string[] } {
  if (!row) return { best: null, visit: [] };
  const visit = words(row['places_to_visit']).map((v) => clip(v.split(/\s\(|:\s/)[0]!.trim(), 60)).filter((v) => v.length > 0);
  return { best: text(row['best_time']), visit: [...new Set(visit)].slice(0, 20) };
}

/**
 * A place's sheet with its guide's read on it: the best time to go as one more reason (the App's rich Details draws the
 * reasons, never facts), and the places to visit as the things the crew can do. Null when the guide adds nothing.
 */
export function withGuide(details: OptionDetailsT | null, guide: { best: string | null; visit: string[] }): OptionDetailsT | null {
  const best = guide.best ? clip(`Best time to go: ${guide.best}`, 140) : null;
  const why = details?.why ?? [];
  const reasons = best && !why.includes(best) ? [...why, best].slice(0, 5) : why;
  if (reasons === why && guide.visit.length === 0) return null;
  return { ...(details ?? {}), ...(reasons.length ? { why: reasons } : {}), ...(guide.visit.length ? { activities: guide.visit } : {}) };
}

/** A place on a card, for its reads in the background: its name, and its guide's own name on ixigo when the explorer gave it. */
export interface PlacePick { cardId: string; optionId: string; name: string; guide?: string }

/**
 * A place's guide on ixigo by the name its guide goes by: the explorer's own ("agra"), else the place as named. The
 * guide recipe makes its page from the words, and "Agra, Uttar Pradesh, India" made /plan/agra-uttar-pradesh-india,
 * which has no guide (prod drill, 11 Oct: no things to do on any place).
 */
export const guideName = (o: { title: string; facts: Record<string, unknown> }): string =>
  typeof o.facts['guide'] === 'string' && o.facts['guide'].trim() !== '' ? o.facts['guide'].trim() : o.title;

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
  picks: PlacePick[],
): Promise<void> {
  for (const pick of picks) {
    try {
      const found = d.placeFor ? await d.placeFor(pick.name, { tripId }).catch(() => null) : null;
      const guide = await d.engine.answer('plan.destination', { place: pick.guide ?? pick.name }, { tripId, background: true }).catch(() => null);
      const { best, visit } = fromGuide(guide?.as === 'facts' ? guide.rows[0] : undefined);
      const option = (await d.results.card(tripId, pick.cardId))?.card.options.find((o) => o.option_id === pick.optionId);
      if (!option) continue;
      const details = withGuide(option.details ?? null, { best, visit });
      const place = found?.place ?? null;
      // The place's own hero replaces the explorer's small photo: it is the first of the labelled photos that follow it.
      const fields = {
        ...(place ? { place: { ...place, name: clip(place.name, 120) } } : {}),
        ...(place?.photos?.length ? { photos: place.photos.slice(0, 12) } : {}),
        ...(place?.photo_url ? { image_url: place.photo_url } : {}),
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
  results: Pick<ResultsStore, 'offer'> & Partial<Pick<ResultsStore, 'get'>>;
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
    const saveAs = async (place: string, requestId: () => string): Promise<boolean> => {
      const title = retitled(pack.trip.title, pack.trip.destination?.name ?? null, place);
      const saved = await d.save(pack, { destination: place, ...(title ? { title } : {}) }, requestId).catch((err: unknown) => {
        d.log?.warn({ tripId, err: String(err).slice(0, 200) }, "travel: a place the vote picked didn't become the trip's");
        return null;
      });
      if (saved && !saved.ok) d.log?.warn({ tripId, error: saved.error }, "travel: a place the vote picked didn't become the trip's");
      return saved?.ok === true;
    };
    if (await saveAs(offer.title, () => stableId('go_trip', tripId, decision.decision_id))) return null;
    // The card names a place with its state ("Manali, Himachal Pradesh"), which ixigo's place box doesn't pin, while the
    // city alone it does (prod, 12 Oct: Manali and Jaipur won, and the trips never got a place while Go said they had).
    const picked = offer.title.split(',')[0]!.trim();
    if (picked && picked !== offer.title.trim() && (await saveAs(picked, () => stableId('go_trip', tripId, decision.decision_id, 'city')))) return null;
    // A region or a country ixigo can't pin (p1-a, 11 Oct: Morocco won, and the trip never moved): the town the group
    // would stay in there, as the place Go picked it with (suggest_places stay_in), and one line naming it. The App
    // posted who won already.
    const option = d.results.get ? (await d.results.get(tripId, offer.resultsId).catch(() => null))?.options[offer.n - 1] : undefined;
    const stayIn = typeof option?.facts['stay_in'] === 'string' ? option.facts['stay_in'].trim() : '';
    if (!stayIn || stayIn.toLowerCase() === picked.toLowerCase()) return null;
    if (!(await saveAs(stayIn, () => stableId('go_trip', tripId, decision.decision_id, 'stay_in')))) return null;
    return { line: clip(`The trip is set to ${stayIn}, the town most people stay in for ${picked}.`, 200) };
  };
}

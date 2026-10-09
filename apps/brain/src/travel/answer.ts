/**
 * A finished search that answers itself, with no second model round: the lead's speed fix after p4's drills (the line
 * came about 15 s after the data, from the model's round after the search). Code decides when the ask is plain; any
 * doubt goes to the model, which answers in the group's language and settles what the data can't.
 *
 * The model still answers when the ask is not one plain search: a question or judgement about the options, a second
 * request, a condition the read can't take, several searches at once, nothing that fits, a search from earlier context
 * (the turn's message is not itself the ask), a proactive or wake turn, or a message not plainly in English.
 */
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { clip, formatInr } from './cards.js';
import { asked } from './filters.js';
import { agreedDates, readTravelAsk } from './recipes/ask.js';
import { airportOf, busCityOf, norm, stationOf, stayPlaceOf } from './recipes/places.js';
import type { ResultOption } from './results.js';
import type { TravelKind, TravelQuery } from './travel.js';

export type Plain = { ok: true } | { ok: false; why: string };
const no = (why: string): Plain => ({ ok: false, why });

/** Words that ask Go to judge, compare or do more than show the list: those turns go to the model. */
const JUDGEMENT =
  /\b(which|what|who|why|how|best|better|worth|compare|comparison|vs|versus|recommend|suggest|should|would|review|reviews|rating|rated|stars?|closest|nearest|near|nearby|close|walk|walking|beach|view|quiet|party|family|kids?|pets?|kitchen|wifi|parking|breakfast|budget|cheap|cheapest|expensive|luxury|head|each|also|then|plus|remind|vote|book|pay|cancel|hold|reserve|explain|without|except|not|no|instead|other|another|more|again|too)\b/g;

/** Hinglish words a plain English ask never holds: the model answers in the group's language. */
const HINGLISH =
  /\b(se|ke|ka|ki|ko|kal|parso|aaj|dikhao|dikha|chahiye|bhai|yaar|kya|hai|hain|karo|kar|mein|aur|wala|wali|acha|accha|haan|nahi|nahin|kuch|koi|sab|log|logon|tha|thi|raat|shaam|subah|abhi|jaldi|sasta|wahan|yahan|chalo|bata|batao|dekh|dekho|liye)\b/;

/** English, plainly: no letter outside A to Z (another script), and none of the Hinglish words. */
export function plainEnglish(text: string): boolean {
  if ([...text].some((ch) => /\p{L}/u.test(ch) && !/[A-Za-z]/.test(ch))) return false;
  return !HINGLISH.test(text.toLowerCase());
}

/** A judgement or second-request word in the ask, other than one the search itself already holds (its must-haves). */
export function judgementIn(text: string, q: TravelQuery): string | null {
  const explained = new Set<string>([
    ...(q.mustHave?.includes('breakfast') ? ['breakfast'] : []),
    ...(q.mustHave?.includes('beach') ? ['beach', 'near', 'close'] : []),
  ]);
  for (const m of text.toLowerCase().matchAll(JUDGEMENT)) if (!explained.has(m[1]!)) return m[1]!;
  return null;
}

/** The same place, as typed or by the code the recipes resolve it to ("delhi" and "DEL"). */
function samePlace(kind: TravelKind, a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (norm(a) === norm(b)) return true;
  try {
    if (kind === 'flights') return airportOf(a).code === airportOf(b).code;
    if (kind === 'trains') return stationOf(a).code === stationOf(b).code;
    if (kind === 'buses') return busCityOf(a).id === busCityOf(b).id;
    const [x, y] = [stayPlaceOf(a), stayPlaceOf(b)];
    return x.location.locationId === y.location.locationId && x.half === y.half && x.areas.join() === y.areas.join();
  } catch {
    return false;
  }
}

/** Every condition the read took is in the search, the same: the model may add more, never drop or change one. */
function agrees(kind: TravelKind, read: TravelQuery, q: TravelQuery): boolean {
  if (kind === 'stays') {
    if (!samePlace(kind, read.area, q.area ?? q.to) || read.checkIn !== q.checkIn || read.checkOut !== q.checkOut) return false;
  } else if (!samePlace(kind, read.from, q.from) || !samePlace(kind, read.to, q.to) || read.date !== q.date) return false;
  const same = <K extends keyof TravelQuery>(k: K): boolean => read[k] === undefined || read[k] === q[k];
  return same('departAfter') && same('departBefore') && same('arriveBefore') && same('maxPriceMinor') && same('guests') &&
    (read.mustHave ?? []).every((m) => (q.mustHave ?? []).includes(m));
}

export interface PlainAskContext {
  wake: DeskItem[];
  pack: TripPack;
  /** The tools the model asked for in this round; absent for the early search, which no model asked for. */
  roundTools?: string[];
  /** Today in the trip's time zone, YYYY-MM-DD. */
  today: string;
}

/**
 * Whether this search answers the turn's one plain ask: one message to Go, plainly in English, read as this very search
 * (kind, places, dates and every condition it names), asking nothing more, and the only tool of its round.
 */
export function plainAsk(kind: TravelKind, q: TravelQuery, c: PlainAskContext): Plain {
  // A turn with no wake items to read (a tool run outside a turn) is never a plain ask.
  const item = c.wake?.[0];
  if (c.wake?.length !== 1 || item?.kind !== 'message') return no('not one message');
  const p = item.payload as { messageId?: string; namesGo?: boolean } | null;
  if (p?.namesGo !== true) return no('not to Go');
  const m = c.pack.messages.find((x) => x.message_id === (p.messageId ?? item.ref));
  if (!m?.text || m.author.kind !== 'person') return no('not a person\'s message');
  if (c.roundTools && (c.roundTools.length !== 1 || !c.roundTools[0]!.startsWith('search_'))) return no('more than one tool');
  if (!plainEnglish(m.text)) return no('not plainly English');
  const trip = c.pack.trip;
  const read = readTravelAsk(m.text, {
    today: c.today, destination: trip.destination?.name ?? null, dates: trip.dates ?? agreedDates(trip.record ?? [], c.today),
  });
  if (!read || read.kind !== kind) return no('not read as this search');
  if (!agrees(kind, read.query, q)) return no('not the search asked for');
  const word = judgementIn(m.text, q);
  if (word) return no(`asks more ("${word}")`);
  return { ok: true };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dateOf = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
/** "Fri 6 Nov". */
export const dayText = (iso: string): string => {
  const d = dateOf(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
/** "6 to 9 Nov", or "30 Nov to 2 Dec". */
const rangeText = (a: string, b: string): string => {
  const [x, y] = [dateOf(a), dateOf(b)];
  return x.getUTCMonth() === y.getUTCMonth()
    ? `${x.getUTCDate()} to ${y.getUTCDate()} ${MONTHS[y.getUTCMonth()]}`
    : `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} to ${y.getUTCDate()} ${MONTHS[y.getUTCMonth()]}`;
};
const titleWords = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const listOf = (words: string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/** "6 Nov". */
const dayMonth = (iso: string): string => {
  const d = dateOf(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/**
 * The card's title for a search that answers itself, as the model's titles read: the kind with its condition, the
 * places, and the day or the stay's dates. "Pool stays in North Goa, 6 to 9 Nov", "Buses, Mumbai to Goa, 6 Nov",
 * "Non-stop flights, Delhi to Goa, 6 Nov".
 */
export function answerTitle(kind: TravelKind, q: TravelQuery): string {
  if (kind === 'stays') {
    const head = q.mustHave?.includes('pool') ? 'Pool stays' : 'Stays';
    const when = q.checkIn && q.checkOut ? `, ${rangeText(q.checkIn, q.checkOut)}` : '';
    return clip(`${head} in ${titleWords(q.area ?? q.to ?? 'Goa')}${when}`, 80);
  }
  const noun = { flights: 'Flights', trains: 'Trains', buses: 'Buses' }[kind];
  const head = q.mustHave?.includes('non_stop') ? `Non-stop ${noun.toLowerCase()}` : noun;
  return clip(`${head}, ${titleWords(q.from ?? '')} to ${titleWords(q.to ?? '')}${q.date ? `, ${dayMonth(q.date)}` : ''}`, 80);
}

/**
 * The card's line, built from the options the card shows: the search's scope and conditions and the cheapest price on
 * the card, said to whoever asked (CARD_LINE: no ids, no "I'll", no count of the card's options). Never a price the card
 * does not show (a stays card shows the engine's first three, not the cheapest: staging pass, 8 Oct). "Pool stays in
 * North Goa for 6 to 9 Nov, from ₹4,334 a night." "Flights Delhi to Goa on Fri 6 Nov, leaving after 7:00 pm, from
 * ₹3,890 per person."
 */
export function answerLine(kind: TravelKind, q: TravelQuery, shown: ReadonlyArray<{ priceMinor?: number; priceNote?: string }>): string {
  const priced = shown.filter((o): o is { priceMinor: number; priceNote?: string } => (o.priceMinor ?? 0) > 0);
  const cheapest = priced.reduce<(typeof priced)[number] | undefined>((a, o) => (!a || o.priceMinor < a.priceMinor ? o : a), undefined);
  const unit = kind === 'stays' ? 'a night' : (cheapest?.priceNote ?? 'per person').replace(/,\s*from$/i, '');
  const from = cheapest ? `, from ${formatInr(cheapest.priceMinor)} ${unit}` : '';
  if (kind === 'stays') {
    const terms = asked(kind, q).filter((t) => t !== 'with a pool');
    const head = q.mustHave?.includes('pool') ? 'Pool stays' : 'Stays';
    const when = q.checkIn && q.checkOut ? ` for ${rangeText(q.checkIn, q.checkOut)}` : '';
    return `${head} in ${titleWords(q.area ?? q.to ?? 'Goa')}${when}${terms.length ? `, ${listOf(terms)}` : ''}${from}.`;
  }
  const noun = { flights: 'Flights', trains: 'Trains', buses: 'Buses' }[kind];
  const terms = asked(kind, q);
  return `${noun} ${titleWords(q.from ?? '')} to ${titleWords(q.to ?? '')}${q.date ? ` on ${dayText(q.date)}` : ''}${terms.length ? `, ${listOf(terms)}` : ''}${from}.`;
}

/** A filter by its name and by what it filters for: "pool", "a pool". */
const FILTERS: Record<string, [string, string]> = { pool: ['pool', 'a pool'], breakfast: ['breakfast', 'breakfast'], free_cancellation: ['free cancellation', 'free cancellation'] };

/**
 * Options read without filters ixigo left off (TravelSearch.unapplied), in plain words: "ixigo's pool filter didn't load
 * in time, so these aren't filtered for a pool". Before the card's line, and in the search's summary.
 */
export function leftOff(unapplied: readonly string[]): string {
  const of = (c: string): [string, string] => FILTERS[c] ?? [c.replace(/_/g, ' '), c.replace(/_/g, ' ')];
  const names = unapplied.map((c) => of(c)[0]);
  return `ixigo's ${listOf(names)} filter${names.length > 1 ? 's' : ''} didn't load in time, so these aren't filtered for ${listOf(unapplied.map((c) => of(c)[1]))}`;
}

/** A line with words before it ("Already on ixigo: "), its own first letter then lower case. */
export const ledBy = (lead: string | undefined, line: string): string => (lead ? `${lead}${line.charAt(0).toLowerCase()}${line.slice(1)}` : line);

/**
 * The line for a journey ixigo shows only as a link (flights from the box, for now): where they are, who they're set
 * for, and that Go notes a pick but books nothing. "Flights Delhi to Goa on Fri 6 Nov are on ixigo, set for 3 from
 * Delhi, leaving after 7:00 pm: book there, and tell me which one so I can note it for the group."
 */
export function linkLine(kind: TravelKind, q: TravelQuery, who: string | null): string {
  const noun = { flights: 'Flights', trains: 'Trains', buses: 'Buses', stays: 'Stays' }[kind];
  const where = kind === 'stays' ? ` in ${titleWords(q.area ?? q.to ?? '')}` : ` ${titleWords(q.from ?? '')} to ${titleWords(q.to ?? '')}`;
  const set = [...(who ? [`set ${who}`] : []), ...asked(kind, q)];
  return `${noun}${where}${q.date ? ` on ${dayText(q.date)}` : ''} are on ixigo${set.length ? `, ${set.join(', ')}` : ''}: book there, and tell me which one so I can note it for the group.`;
}

/**
 * The card's picks, by their numbers in the saved list (1-based), in the order shown. Stays: the engine's first three
 * (its order already holds the conditions, the rating and the region's spread). Journeys: the three cheapest that fit,
 * one fare a train, shown by departure.
 */
export function directPicks(kind: TravelKind, options: ResultOption[]): number[] {
  if (kind === 'stays') return options.slice(0, 3).map((_, i) => i + 1);
  const seen = new Set<string>();
  const cheapest = options
    .map((o, i) => ({ o, n: i + 1 }))
    .sort((a, b) => (a.o.priceMinor ?? Number.MAX_SAFE_INTEGER) - (b.o.priceMinor ?? Number.MAX_SAFE_INTEGER) || a.n - b.n)
    .filter(({ o }) => {
      const key = kind === 'trains' ? (o.journey?.number ?? o.title) : `${o.title}|${o.journey?.depart_at ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
  return cheapest.sort((a, b) => (a.o.journey?.depart_at ?? '').localeCompare(b.o.journey?.depart_at ?? '') || a.n - b.n).map((x) => x.n);
}

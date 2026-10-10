/**
 * The ixigo asks beyond the four searches that Go starts the moment the message lands, like a search: Jev's question 10
 * picks the kind (reflex/questions.ts FAST_CHOICES), and this file reads its slots from the words. Each kind is one recipe
 * of the book. A slot the words don't give plainly (a train by its name, an option nobody pointed at) gives null, and the
 * composer asks or looks it up as usual. A new kind is its choice in questions.ts, its line in q10_recipe, and one entry
 * in FAST_ASKS here. A kind whose recipe is not in the book yet (a PNR, a flight's status...) starts nothing: its entry
 * names the inputs that recipe takes.
 *
 * A PNR only says its ask is one: its recipe is a link to ixigo's PNR page, which takes no number, so the digits are never
 * passed on, logged or kept in Go's stores, and never shown back to Jev (questions.ts hides ten-digit numbers from it).
 */
import type { FastChoice } from '../../reflex/questions.js';
import { A_WATCH, datesIn, NOT_PLACES, placesIn, readTravelAsk, type AskContext } from './ask.js';

/** A recipe to run, with its inputs as the engine takes them (`given`) and as the ixigo tool takes them (`asked`). */
export interface FastAsk {
  recipe: string;
  given: Record<string, unknown>;
  /** The same inputs as the model gives them to the ixigo tool: an option as results_id#n, never its page. */
  asked: Record<string, string>;
}

/** An option Go showed on a card (a stay, a flight): written as the tool takes it (r_ab12#2), and its own ixigo page. */
export interface ShownOption {
  ref: string;
  page: string;
}

export interface FastContext extends Omit<AskContext, 'kind'> {
  /** The shown option the line points at (option-on-card.ts), for the kinds in OPTION_KINDS; null when none or unclear. */
  option?: ShownOption | null;
}

type Reader = (text: string, ctx: FastContext) => FastAsk | null;

const plain = (recipe: string, inputs: Record<string, string>): FastAsk => ({ recipe, given: inputs, asked: inputs });

/** A train's 5-digit number, when the line gives exactly one: "12051", never a price ("₹12,000", "15000.50") or a PNR's digits. */
export function trainNumberIn(text: string): string | null {
  const found = [...text.matchAll(/(?<!\d|₹\s?|\d[,.])(\d{5})(?!\d|[,.]\d)/g)].map((m) => m[1]!);
  return new Set(found).size === 1 ? found[0]! : null;
}

/** A PNR: the one 10-digit number in the line. */
export function pnrIn(text: string): string | null {
  const found = [...text.matchAll(/(?<!\d)(\d{10})(?!\d)/g)].map((m) => m[1]!);
  return found.length === 1 ? found[0]! : null;
}

/** India's airlines' codes, as a flight number starts: "6E 2134", "AI-864", "qp1402". */
const CARRIERS = ['6E', 'AI', 'IX', 'I5', 'UK', 'SG', 'QP', 'G8', '9I', 'S5'];

/** The one flight the line names, as its carrier code and number. */
export function flightIn(text: string): { carrier: string; number: string } | null {
  const re = new RegExp(`(?<![A-Za-z0-9])(${CARRIERS.join('|')})[\\s-]?(\\d{2,4})(?!\\d)`, 'gi');
  const found = new Map([...text.matchAll(re)].map((m) => [`${m[1]!.toUpperCase()} ${m[2]!}`, { carrier: m[1]!.toUpperCase(), number: m[2]! }]));
  return found.size === 1 ? [...found.values()][0]! : null;
}

/** A coach as the site writes it: "B2", "S5", "A1", "H1". */
export function coachIn(text: string): string | null {
  const found = [...text.matchAll(/(?<![A-Za-z0-9])([ABCDEHMS]{1,2}\d{1,2})(?![A-Za-z0-9])/g)].map((m) => m[1]!);
  return new Set(found).size === 1 ? found[0]! : null;
}

/** A class of travel as people say it, as ixigo's code: "3A", "third AC", "sleeper". */
const CLASSES: Array<[string, RegExp]> = [
  ['1A', /\b(1a|1 ?ac|first ac)\b/i],
  ['2A', /\b(2a|2 ?ac|second ac|2 tier)\b/i],
  ['3E', /\b(3e|3 ?ac economy)\b/i],
  ['3A', /\b(3a|3 ?ac|third ac|3 tier)\b/i],
  ['SL', /\b(sl|sleeper)\b/i],
  ['CC', /\b(cc|chair car)\b/i],
  ['EC', /\b(ec|executive chair)\b/i],
  ['2S', /\b(2s|second sitting)\b/i],
];

export function classIn(text: string): string | null {
  const found = CLASSES.filter(([, re]) => re.test(text)).map(([code]) => code);
  return found.length === 1 ? found[0]! : null;
}

/** The one station the tables know in the line. */
const stationIn = (text: string): string | null => {
  const found = placesIn(text, 'trains');
  return found.length === 1 ? found[0]!.name : null;
};

/** The place a guide is asked for: one Go's tables know, else the word after "in" or "of", else the trip's own place. */
function guidePlace(text: string, ctx: FastContext): string | null {
  const known = placesIn(text, 'stays')[0]?.name;
  if (known) return known;
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\b(?:in|of|at|around|near|about)\s+([a-z][a-z-]{2,})/g)) {
    if (!NOT_PLACES.has(m[1]!)) return m[1]!;
  }
  return ctx.destination ?? null;
}

/** The product an offers ask names, as the book's recipe for its offers. */
function offersAsk(text: string, ctx: FastContext): FastAsk {
  if (/\b(trains?|railways?|irctc)\b/i.test(text)) return plain('trains.offers', {});
  if (/\b(bus|buses)\b/i.test(text)) return plain('buses.offers', {});
  // A stay's offers are shown over a place's stays for some nights: the trip's place and dates, when it has them.
  if (/\b(hotels?|stays?|villas?|resorts?)\b/i.test(text) && ctx.destination && ctx.dates) {
    return plain('hotels.offers', { place: ctx.destination, check_in: ctx.dates.start, check_out: ctx.dates.end });
  }
  return plain('offers.list', {});
}

/** A recipe of one shown option: its page for the engine, its results_id#n for the tool. */
const optionAsk = (recipe: string, input: string) => (_text: string, ctx: FastContext): FastAsk | null =>
  ctx.option ? { recipe, given: { [input]: ctx.option.page }, asked: { [input]: ctx.option.ref } } : null;

/** A recipe of one train by its number, with the station (and coach) the line names, when it names one. */
const byTrain = (recipe: string, more: { station?: boolean; coach?: boolean } = {}): Reader => (text) => {
  const train = trainNumberIn(text);
  if (!train) return null;
  const station = more.station ? stationIn(text) : null;
  const coach = more.coach ? coachIn(text) : null;
  return plain(recipe, { train, ...(station ? { station } : {}), ...(coach ? { coach } : {}) });
};

/** Each fast kind's recipe and how its slots are read. */
export const FAST_ASKS: Record<FastChoice, Reader> = {
  train_status: byTrain('trains.running_status'),
  schedule: byTrain('trains.schedule'),
  // Not in the book yet (p5): where a coach stops, and the stations a train can be boarded at.
  coach_position: byTrain('trains.coach_position', { station: true, coach: true }),
  boarding_stations: byTrain('trains.boarding_stations', { station: true }),
  // A card to ixigo's PNR page, where the person checks it on their own phone (p5): the number stays in the message.
  pnr: (text) => (pnrIn(text) ? { recipe: 'trains.pnr_status', given: {}, asked: {} } : null),
  confirm_chance: (text, ctx) => {
    const journey = readTravelAsk(text, { ...ctx, kind: 'trains' });
    if (!journey?.query.from || !journey.query.to || !journey.query.date) return null;
    const train = trainNumberIn(text);
    const cls = classIn(text);
    return plain('trains.confirm_chance', {
      from: journey.query.from, to: journey.query.to, date: journey.query.date, ...(train ? { train } : {}), ...(cls ? { class: cls } : {}),
    });
  },
  // Not in the book yet (p0): a flight's status on its day, today unless the line names another.
  flight_status: (text, ctx) => {
    const flight = flightIn(text);
    if (!flight) return null;
    const date = datesIn(text.toLowerCase(), ctx.today, ctx.dates ?? null)[0]?.day ?? ctx.today;
    return plain('flights.status', { ...flight, date });
  },
  guide: (text, ctx) => {
    const place = guidePlace(text, ctx);
    return place ? plain('plan.destination', { place }) : null;
  },
  offers: offersAsk,
  hotel_rooms: optionAsk('hotels.rooms', 'hotel'),
  hotel_reviews: optionAsk('hotels.reviews', 'hotel'),
  // Not in the book yet (p0): the shown fare's review page, read only.
  fare_review: optionAsk('flights.review', 'option'),
};

/** The kinds whose slot is an option on a card, and the kind of card: the line is matched to one before its slots are read. */
export const OPTION_KINDS: Partial<Record<FastChoice, 'stay' | 'flight'>> = { hotel_rooms: 'stay', hotel_reviews: 'stay', fare_review: 'flight' };

/** The recipe a fast ask runs and its inputs, or null when the words don't give them plainly. A watch is never one. */
export function readFastAsk(choice: FastChoice, text: string, ctx: FastContext): FastAsk | null {
  if (A_WATCH.test(text)) return null;
  return FAST_ASKS[choice](text, ctx);
}

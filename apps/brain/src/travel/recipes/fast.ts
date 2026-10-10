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

/** A fast kind: the recipe it reads (named to the turn when the words don't give its slots, now.ts), and its slots' reader. */
export interface FastKind {
  recipe: string;
  read: Reader;
}

const plain = (recipe: string, inputs: Record<string, string>): FastAsk => ({ recipe, given: inputs, asked: inputs });

/** A kind of one recipe whose reader gives its inputs: `ask` makes the recipe's FastAsk of them. */
const kind = (recipe: string, read: (text: string, ctx: FastContext, ask: (inputs: Record<string, string>) => FastAsk) => FastAsk | null): FastKind => ({
  recipe,
  read: (text, ctx) => read(text, ctx, (inputs) => plain(recipe, inputs)),
});

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

/**
 * The banks and ways to pay ixigo's offers page lists, by the page's own names (its bank checkboxes, 10 Oct), and how
 * people say them. A bank the page doesn't list today still filters the offers by its words (offers.list keeps the offers
 * whose bank matches).
 */
const BANKS: ReadonlyArray<[string, RegExp]> = [
  ['HDFC Bank', /\bhdfc\b/i],
  ['ICICI Bank', /\bicici\b/i],
  ['Axis Bank', /\baxis\b/i],
  ['Kotak Bank', /\bkotak\b/i],
  ['SBI', /\bsbi\b|\bstate bank\b/i],
  ['AU Bank', /\bau (?:small finance )?bank\b|\bau (?:credit |debit )?card\b/i],
  ['RBL Bank', /\brbl\b/i],
  ['IDFC FIRST Bank', /\bidfc\b/i],
  ['J&K Bank', /\bj\s?&\s?k\b|\bjk bank\b|\bjammu\b/i],
  ['Punjab National Bank', /\bpnb\b|\bpunjab national\b/i],
  ['HSBC', /\bhsbc\b/i],
  ['City Union Bank', /\bcity union\b/i],
  ['Indian Overseas Bank', /\bindian overseas\b|\biob\b/i],
  ['Yes Bank', /\byes bank\b/i],
  ['Bank of Baroda', /\bbank of baroda\b|\bbob\b/i],
  ['IndusInd Bank', /\bindusind\b/i],
  ['Federal Bank', /\bfederal bank\b/i],
  ['American Express', /\bamex\b|\bamerican express\b/i],
  ['OneCard', /\bone ?card\b/i],
  ['CRED', /\bcred\b/i],
  ['UPI', /\bupi\b/i],
  ['SalarySe', /\bsalaryse\b/i],
];

/** The one bank or way to pay the line names, as ixigo's offers page names it; null for none or more than one. */
export function bankIn(text: string): string | null {
  const found = BANKS.filter(([, re]) => re.test(text)).map(([name]) => name);
  return found.length === 1 ? found[0]! : null;
}

/** The product an offers ask names, as the book's recipe for its offers, with the bank, product and journey it names. */
function offersAsk(text: string, ctx: FastContext): FastAsk {
  if (/\b(trains?|railways?|irctc)\b/i.test(text)) return plain('trains.offers', {});
  if (/\b(bus|buses)\b/i.test(text)) return plain('buses.offers', {});
  const stays = /\b(hotels?|stays?|villas?|resorts?|homestays?)\b/i.test(text);
  // A stay's offers are shown over a place's stays for some nights: the trip's place and dates, when it has them.
  if (stays && ctx.destination && ctx.dates) {
    return plain('hotels.offers', { place: ctx.destination, check_in: ctx.dates.start, check_out: ctx.dates.end });
  }
  // The filters a person would press on the offers page, from their own words, so this read is the one the turn's ixigo
  // call makes too (exam, 10 Oct: the early read had none, and the call with the bank read the page again).
  const bank = bankIn(text);
  const product = /\b(flights?|fly|flying|airfares?|air ?tickets?)\b/i.test(text) ? 'flights' : stays ? 'hotels' : null;
  const journey = /\b(international|abroad|foreign|videsh)\b/i.test(text) ? 'international' : /\bdomestic\b/i.test(text) ? 'domestic' : null;
  return plain('offers.list', { ...(product ? { product } : {}), ...(journey ? { journey } : {}), ...(bank ? { bank } : {}) });
}

/** A recipe of one shown option: its page for the engine, its results_id#n for the tool. */
const optionAsk = (recipe: string, input: string): FastKind => ({
  recipe,
  read: (_text, ctx) => (ctx.option ? { recipe, given: { [input]: ctx.option.page }, asked: { [input]: ctx.option.ref } } : null),
});

/** A recipe of one train by its number, with the station (and coach) the line names, when it names one. */
const byTrain = (recipe: string, more: { station?: boolean; coach?: boolean } = {}): FastKind =>
  kind(recipe, (text, _ctx, ask) => {
    const train = trainNumberIn(text);
    if (!train) return null;
    const station = more.station ? stationIn(text) : null;
    const coach = more.coach ? coachIn(text) : null;
    return ask({ train, ...(station ? { station } : {}), ...(coach ? { coach } : {}) });
  });

/** Each fast kind's recipe and how its slots are read. */
export const FAST_ASKS: Record<FastChoice, FastKind> = {
  train_status: byTrain('trains.running_status'),
  schedule: byTrain('trains.schedule'),
  // Not in the book yet (p5): where a coach stops, and the stations a train can be boarded at.
  coach_position: byTrain('trains.coach_position', { station: true, coach: true }),
  boarding_stations: byTrain('trains.boarding_stations', { station: true }),
  // A card to ixigo's PNR page, where the person checks it on their own phone (p5): the number stays in the message.
  pnr: kind('trains.pnr_status', (text, _ctx, ask) => (pnrIn(text) ? ask({}) : null)),
  confirm_chance: kind('trains.confirm_chance', (text, ctx, ask) => {
    const journey = readTravelAsk(text, { ...ctx, kind: 'trains' });
    if (!journey?.query.from || !journey.query.to || !journey.query.date) return null;
    const train = trainNumberIn(text);
    const cls = classIn(text);
    return ask({ from: journey.query.from, to: journey.query.to, date: journey.query.date, ...(train ? { train } : {}), ...(cls ? { class: cls } : {}) });
  }),
  // Not in the book yet (p0): a flight's status on its day, today unless the line names another.
  flight_status: kind('flights.status', (text, ctx, ask) => {
    const flight = flightIn(text);
    if (!flight) return null;
    const date = datesIn(text.toLowerCase(), ctx.today, ctx.dates ?? null)[0]?.day ?? ctx.today;
    return ask({ ...flight, date });
  }),
  guide: kind('plan.destination', (text, ctx, ask) => {
    const place = guidePlace(text, ctx);
    return place ? ask({ place }) : null;
  }),
  // The general list; a product the line names reads its own (offersAsk).
  offers: { recipe: 'offers.list', read: offersAsk },
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
  return FAST_ASKS[choice].read(text, ctx);
}

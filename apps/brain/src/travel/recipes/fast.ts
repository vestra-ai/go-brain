/**
 * The ixigo asks beyond the four searches that Go starts the moment the message lands, like a search: Jev's question 10
 * picks the kind (reflex/questions.ts FAST_CHOICES), and this file reads its slots from the words. Each kind is one recipe
 * of the book. A slot the words don't give plainly (a train by its name, a stay nobody pointed at) gives null, and the
 * composer asks or looks it up as usual. A new kind is its choice in questions.ts, its line in q10_recipe, and one entry
 * in FAST_ASKS here.
 *
 * A PNR is read only to start its lookup: it is never logged, never kept in Go's stores, and never shown back to Jev
 * (questions.ts hides ten-digit numbers from it).
 */
import type { FastChoice } from '../../reflex/questions.js';
import { A_WATCH, NOT_PLACES, placesIn, readTravelAsk, type AskContext } from './ask.js';

/** A recipe to run, with its inputs as the engine takes them (`given`) and as the ixigo tool takes them (`asked`). */
export interface FastAsk {
  recipe: string;
  given: Record<string, unknown>;
  /** The same inputs as the model gives them to the ixigo tool: a stay as results_id#n, never its page. */
  asked: Record<string, string>;
}

/** A stay Go showed on a card: its option written as the tool takes it (r_ab12#2), and its own ixigo page. */
export interface ShownStay {
  ref: string;
  page: string;
}

export interface FastContext extends Omit<AskContext, 'kind'> {
  /** The shown stay the line points at (stay-on-card.ts), for a stay's rooms or reviews; null when none or unclear. */
  stay?: ShownStay | null;
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

const stayAsk = (recipe: string) => (_text: string, ctx: FastContext): FastAsk | null =>
  ctx.stay ? { recipe, given: { hotel: ctx.stay.page }, asked: { hotel: ctx.stay.ref } } : null;

const byTrain = (recipe: string): Reader => (text) => {
  const train = trainNumberIn(text);
  return train ? plain(recipe, { train }) : null;
};

/** Each fast kind's recipe and how its slots are read. */
export const FAST_ASKS: Record<FastChoice, Reader> = {
  train_status: byTrain('trains.running_status'),
  schedule: byTrain('trains.schedule'),
  // The book has no PNR recipe yet, so nothing starts until one lands. The tool's inputs leave the number out: a turn
  // takes it from the message, and Go keeps no copy of it past the read.
  pnr: (text) => {
    const pnr = pnrIn(text);
    return pnr ? { recipe: 'trains.pnr_status', given: { pnr }, asked: {} } : null;
  },
  confirm_chance: (text, ctx) => {
    const journey = readTravelAsk(text, { ...ctx, kind: 'trains' });
    if (!journey?.query.from || !journey.query.to || !journey.query.date) return null;
    const train = trainNumberIn(text);
    const cls = classIn(text);
    return plain('trains.confirm_chance', {
      from: journey.query.from, to: journey.query.to, date: journey.query.date, ...(train ? { train } : {}), ...(cls ? { class: cls } : {}),
    });
  },
  guide: (text, ctx) => {
    const place = guidePlace(text, ctx);
    return place ? plain('plan.destination', { place }) : null;
  },
  offers: offersAsk,
  hotel_rooms: stayAsk('hotels.rooms'),
  hotel_reviews: stayAsk('hotels.reviews'),
};

/** The kinds whose slot is a stay on a card: the line is matched to one before its slots are read. */
export const STAY_CHOICES: ReadonlySet<FastChoice> = new Set(['hotel_rooms', 'hotel_reviews']);

/** The recipe a fast ask runs and its inputs, or null when the words don't give them plainly. A watch is never one. */
export function readFastAsk(choice: FastChoice, text: string, ctx: FastContext): FastAsk | null {
  if (A_WATCH.test(text)) return null;
  return FAST_ASKS[choice](text, ctx);
}

/**
 * A cheap read of a travel ask, in English and Hinglish, so Go can start the search the moment the message lands:
 * "@Go flights Delhi to Goa Friday" is flights from Delhi to Goa on the trip's Friday, or the coming one on a trip with
 * no dates ahead. It reads only the places the recipes' tables know and plain dates; anything less than a whole ask
 * gives null, and the composer searches as usual.
 * A journey's clear conditions are read too, so the answer the turn gets already holds them and show_options is the one
 * call: a clock time with am or pm ("after 7 pm", "arriving by 10 am"), "evening" (after 5 pm), "can't leave before 6"
 * (after 6 pm), non-stop, and a price cap per person ("under 6k"). A bare "after 7" is not read: it could be either.
 * A stay's pool, breakfast or free cancellation is read, since ixigo filters on those and the list depends on them; its
 * price ("8k a head") and "near the beach" are left to the model.
 */
import type { TravelKind, TravelQuery } from '../travel.js';
import { addDays } from './recipe.js';
import { airportOf, placeWords, stationOf } from './places.js';

export interface TravelAsk { kind: TravelKind; query: TravelQuery }

export interface AskContext {
  /** Today in the trip's time zone, YYYY-MM-DD. */
  today: string;
  /** The trip's destination, for "trains from Mumbai" or "a villa with a pool". */
  destination?: string | null;
  /** The trip's dates, for a stay asked for without its own. */
  dates?: { start: string; end: string } | null;
  /** The kind of search, when Jev is sure of it (question 10): it wins over the kind words, which miss some Hinglish. */
  kind?: TravelKind;
}

const KINDS: Array<[TravelKind, RegExp]> = [
  ['flights', /\b(flights?|fly|flying|plane|airfares?|air tickets?)\b/i],
  ['trains', /\b(trains?|railways?)\b/i],
  ['buses', /\b(bus|buses|busses)\b/i],
  ['stays', /\b(hotels?|stays?|villas?|resorts?|homestays?|airbnbs?|places? to stay)\b/i],
];

/** Another job for Go about the same things: a vote, a booking, a payment, a reminder. Never a search to start. */
const NOT_A_SEARCH = /\b(vote|votes|voting|poll|book|booked|booking|pay|paid|payment|cancel|remind)\b/i;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, tues: 2, wednesday: 3, weds: 3, thursday: 4, thurs: 4, friday: 5, fri: 5, saturday: 6,
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Found { at: number; end: number }

/** "6 Nov" near today as YYYY-MM-DD: this year if that is not past, else next year. Null for no such day. */
function dayOf(day: number, month: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const iso = (y: number): string => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${iso(year)}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== day) return null;
  return iso(year) >= today ? iso(year) : iso(year + 1);
}

/**
 * The trip's own day of the week: on a trip with dates still ahead, "Friday" is the Friday from the day before it starts
 * (an overnight journey) to its last day, not this week's. Null when the trip has none such, or no dates.
 */
function tripsWeekday(weekday: number, today: string, trip: AskContext['dates']): string | null {
  if (!trip || trip.end < today) return null;
  for (let day = addDays(trip.start, -1); day <= trip.end; day = addDays(day, 1)) {
    if (day >= today && new Date(`${day}T00:00:00Z`).getUTCDay() === weekday) return day;
  }
  return null;
}

/** Every date the text names, in the order it names them. */
function datesIn(lower: string, today: string, trip: AskContext['dates'] = null): Array<Found & { day: string }> {
  const out: Array<Found & { day: string }> = [];
  const add = (at: number, end: number, day: string | null): void => {
    if (day && !out.some((d) => at < d.end && end > d.at)) out.push({ at, end, day });
  };
  for (const m of lower.matchAll(new RegExp(`\\b${DAY}\\s*(?:-|to|till|until)\\s*${DAY}\\s*(?:of\\s+)?${MONTH}\\b`, 'g'))) {
    const month = MONTHS.indexOf(m[3]!.slice(0, 3)) + 1;
    const first = m[0].indexOf(m[2]!, m[1]!.length);
    add(m.index, m.index + m[1]!.length, dayOf(Number(m[1]), month, today));
    add(m.index + first, m.index + m[0].length, dayOf(Number(m[2]), month, today));
  }
  for (const m of lower.matchAll(new RegExp(`\\b${DAY}\\s*(?:of\\s+)?${MONTH}\\b`, 'g'))) {
    add(m.index, m.index + m[0].length, dayOf(Number(m[1]), MONTHS.indexOf(m[2]!.slice(0, 3)) + 1, today));
  }
  for (const m of lower.matchAll(new RegExp(`\\b${MONTH}\\s+${DAY}\\b`, 'g'))) {
    add(m.index, m.index + m[0].length, dayOf(Number(m[2]), MONTHS.indexOf(m[1]!.slice(0, 3)) + 1, today));
  }
  for (const m of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(?:20)?\d{2})?\b/g)) {
    add(m.index, m.index + m[0].length, dayOf(Number(m[1]), Number(m[2]), today));
  }
  for (const m of lower.matchAll(/\b(day after tomorrow|parso|parson)\b/g)) add(m.index, m.index + m[0].length, addDays(today, 2));
  for (const m of lower.matchAll(/\b(today|tonight|aaj)\b/g)) add(m.index, m.index + m[0].length, today);
  for (const m of lower.matchAll(/\b(tomorrow|kal)\b/g)) add(m.index, m.index + m[0].length, addDays(today, 1));
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  for (const m of lower.matchAll(new RegExp(`\\b(${Object.keys(WEEKDAYS).join('|')})\\b`, 'g'))) {
    // The trip's, when it has one; else the coming one: "Friday" said on a Friday is next week's.
    const ahead = ((WEEKDAYS[m[1]!]! - weekday + 7) % 7) || 7;
    add(m.index, m.index + m[0].length, tripsWeekday(WEEKDAYS[m[1]!]!, today, trip) ?? addDays(today, ahead));
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The places of this kind the text names, in order, by their names in the tables (and airport or station codes in capitals). */
function placesIn(text: string, kind: TravelKind): Array<Found & { name: string }> {
  const lower = text.toLowerCase();
  const out: Array<Found & { name: string }> = [];
  for (const word of placeWords(kind)) {
    for (const m of lower.matchAll(new RegExp(`(?<![a-z])${escape(word)}(?![a-z])`, 'g'))) {
      const end = m.index + word.length;
      if (!out.some((p) => m.index < p.end && end > p.at)) out.push({ at: m.index, end, name: word });
    }
  }
  if (kind === 'flights' || kind === 'trains') {
    const known = kind === 'flights' ? airportOf : stationOf;
    for (const m of text.matchAll(/\b[A-Z]{2,4}\b/g)) {
      const end = m.index + m[0].length;
      if (out.some((p) => m.index < p.end && end > p.at)) continue;
      try {
        known(m[0]);
        out.push({ at: m.index, end, name: m[0] });
      } catch {
        // a word in capitals, not a code Go knows
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const TIME = '(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm)';

/** "7 pm", "7:30pm" as 19:00 and 19:30; a bare hour (no am or pm) only where the words make it the evening. */
function clock(hour: string, minutes: string | undefined, half: string | undefined): string | null {
  let h = Number(hour);
  if (h < 1 || h > 12) return null;
  if (half === 'pm' || (half === undefined && h < 12)) h = h === 12 ? 12 : h + 12;
  else if (half === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${minutes ?? '00'}`;
}

/** A journey's clear conditions. Each one read goes into the search, which applies it in code like the tool's own. */
function conditionsIn(lower: string, kind: TravelKind): Partial<TravelQuery> {
  const out: Partial<TravelQuery> = {};
  const later = (t: string | null): void => {
    if (t && (!out.departAfter || t > out.departAfter)) out.departAfter = t;
  };
  // "can't leave before 6": the end of a working day, so the evening, unless it says am.
  let rest = lower;
  for (const m of lower.matchAll(/\b(?:can'?t|cannot|can not|won'?t)\s+(?:leave|go|fly|start)\s+(?:before|till|until)\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/g)) {
    later(clock(m[1]!, m[2], m[3]));
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(new RegExp(`\\b(?:after|post)\\s+${TIME}\\b`, 'g'))) later(clock(m[1]!, m[2], m[3]));
  if (/\b(evening|shaam)\b/.test(rest)) later('17:00');
  for (const m of rest.matchAll(new RegExp(`\\b(?:before|by)\\s+${TIME}\\b`, 'g'))) {
    const t = clock(m[1]!, m[2], m[3]);
    if (!t) continue;
    // "arriving by 10 am", "reach Goa before 2 pm": the arrival; otherwise the departure.
    if (/\b(arriv|reach|land|pahunch|there)\w*\b[^.?!]{0,24}$/.test(rest.slice(0, m.index))) out.arriveBefore = t;
    else out.departBefore = t;
  }
  if (kind === 'flights' && /\b(non[\s-]?stop|direct)\b/.test(rest)) out.mustHave = ['non_stop'];
  // A cap per person: "under 6k", "below ₹5,500". Not one for everyone together, and not hours or kilometres.
  const cap = /\b(?:under|below|less than|within|max|upto|up to)\s*(?:rs\.?\s*|₹\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?(?![a-z\d])(?!\s*(?:hours?|hrs?|mins?|minutes?|km|kms|stops?|people|log)\b)/.exec(rest);
  if (cap && !/\b(total|in all|for all|altogether|for everyone)\b/.test(rest)) {
    const rupees = Number(cap[1]!.replace(/,/g, '')) * (cap[2] ? 1000 : 1);
    if (Number.isFinite(rupees) && rupees >= 500) out.maxPriceMinor = Math.round(rupees * 100);
  }
  return out;
}

/** The must-haves ixigo filters a stay search on, as people say them. */
const STAY_NEEDS: Array<[NonNullable<TravelQuery['mustHave']>[number], RegExp]> = [
  ['pool', /\bpool\b/],
  ['breakfast', /\b(breakfast|nashta)\b/],
  ['free_cancellation', /\bfree cancell?ation\b/],
];

/** People said how many: "4 people", "5 log", "6 of us". */
function guestsIn(lower: string): number | undefined {
  const m = /\b(\d{1,2})\s*(people|persons|adults|log|logon|of us|travellers|travelers|guests|pax|members)\b/.exec(lower);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 30 ? n : undefined;
}

/** The ask in a message, or null when it is not one whole search of one kind. */
export function readTravelAsk(text: string, ctx: AskContext): TravelAsk | null {
  if (NOT_A_SEARCH.test(text)) return null;
  const kinds = ctx.kind ? [ctx.kind] : KINDS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (kinds.length !== 1) return null;
  const kind = kinds[0]!;
  const lower = text.toLowerCase();
  const places = placesIn(text, kind);
  const dates = datesIn(lower, ctx.today, ctx.dates ?? null);
  const guests = guestsIn(lower);
  const extra = guests ? { guests } : {};

  if (kind === 'stays') {
    const area = places[0]?.name ?? ctx.destination;
    let checkIn = dates[0]?.day;
    let checkOut = dates[1]?.day;
    const nights = /\b(\d{1,2})\s*(nights?|raat)\b/.exec(lower);
    if (checkIn && !checkOut && nights) checkOut = addDays(checkIn, Number(nights[1]));
    if (!checkIn && ctx.dates) [checkIn, checkOut] = [ctx.dates.start, ctx.dates.end];
    if (!area || !checkIn || !checkOut || checkOut <= checkIn) return null;
    const needs = STAY_NEEDS.filter(([, re]) => re.test(lower)).map(([need]) => need);
    return { kind, query: { area, checkIn, checkOut, ...extra, ...(needs.length ? { mustHave: needs } : {}) } };
  }

  const date = dates[0]?.day;
  if (!date) return null;
  const before = (p: Found): string => lower.slice(Math.max(0, p.at - 6), p.at);
  const after = (p: Found): string => lower.slice(p.end, p.end + 10);
  const isFrom = (p: Found): boolean => /\bfrom\s+$/.test(before(p)) || /^\s+se\b/.test(after(p));
  let from: string | undefined;
  let to: string | undefined;
  if (places.length >= 2) {
    const [a, b] = [places[0]!, places[1]!];
    [from, to] = isFrom(b) && !isFrom(a) ? [b.name, a.name] : [a.name, b.name];
  } else if (places.length === 1 && isFrom(places[0]!) && ctx.destination) {
    // "trains from Mumbai on Thursday": to the trip's destination.
    [from, to] = [places[0]!.name, ctx.destination];
  }
  if (!from || !to || from === to) return null;
  return { kind, query: { from, to, date, ...extra, ...conditionsIn(lower, kind) } };
}

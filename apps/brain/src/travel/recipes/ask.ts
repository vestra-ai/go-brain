/**
 * A cheap read of a travel ask, in English and Hinglish, so Go can start the search the moment the message lands:
 * "@Go flights Delhi to Goa Friday" is flights from Delhi to Goa on the coming Friday. It reads only the places the
 * recipes' tables know and plain dates; anything less than a whole ask gives null, and the composer searches as usual.
 * Constraints ("after 6 pm", "under 8k") are not read: the search fetches the whole list and the tool applies them.
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
}

const KINDS: Array<[TravelKind, RegExp]> = [
  ['flights', /\b(flights?|fly|flying|plane|airfares?|air tickets?)\b/i],
  ['trains', /\b(trains?|railways?)\b/i],
  ['buses', /\b(bus|buses|busses)\b/i],
  ['stays', /\b(hotels?|stays?|villas?|resorts?|homestays?|airbnbs?|places? to stay)\b/i],
];

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

/** Every date the text names, in the order it names them. */
function datesIn(lower: string, today: string): Array<Found & { day: string }> {
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
    // The coming one: "Friday" said on a Friday is next week's.
    const ahead = ((WEEKDAYS[m[1]!]! - weekday + 7) % 7) || 7;
    add(m.index, m.index + m[0].length, addDays(today, ahead));
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

/** People said how many: "4 people", "5 log", "6 of us". */
function guestsIn(lower: string): number | undefined {
  const m = /\b(\d{1,2})\s*(people|persons|adults|log|logon|of us|travellers|travelers|guests|pax|members)\b/.exec(lower);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 30 ? n : undefined;
}

/** Travel talk, to Go or not: a travel word with a place or a date ("trains from Mumbai?", "villa for Friday"). */
export function travelTalk(text: string, today: string): boolean {
  const kinds = KINDS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (kinds.length === 0) return false;
  return datesIn(text.toLowerCase(), today).length > 0 || kinds.some((k) => placesIn(text, k).length > 0);
}

/** The ask in a message, or null when it is not one whole search of one kind. */
export function readTravelAsk(text: string, ctx: AskContext): TravelAsk | null {
  const kinds = KINDS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (kinds.length !== 1) return null;
  const kind = kinds[0]!;
  const lower = text.toLowerCase();
  const places = placesIn(text, kind);
  const dates = datesIn(lower, ctx.today);
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
    return { kind, query: { area, checkIn, checkOut, ...extra } };
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
  return { kind, query: { from, to, date, ...extra } };
}

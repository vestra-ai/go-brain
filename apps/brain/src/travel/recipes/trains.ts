/**
 * Trains on ixigo.com (p4's T1, T2 and T3 in one load): the results page for one date, its train list and its seat
 * availability. One option per train and class, General quota, with the seat status, ixigo's chance a waitlisted ticket
 * confirms, and Tatkal when it is open. Fares are per person, IRCTC taxes and fees in ("price is per adult" on the page).
 */
import { z } from 'zod';
import { TravelError } from '../mcp-travel.js';
import type { TravelQuery } from '../travel.js';
import { stationOf } from './places.js';
import {
  addDays, bodiesFor, ddmmyyyy, highlights, hoursMinutes, istAt, IXIGO, paise, pageScript, readBody, readRows, RECIPE_TTL_MS,
  type Capture, type Recipe, type RecipeOption,
} from './recipe.js';

export interface TrainSlots { from: string; to: string; date: string }

const BETWEEN = '/trains/v1/search/between/';
const AVAILABILITY = '/api/v3/trains/availability';

const CLASS_WORDS: Record<string, string> = {
  '1A': 'AC First Class', '2A': 'AC 2 Tier', '3A': 'AC 3 Tier', '3E': 'AC 3 Economy', SL: 'Sleeper', CC: 'AC Chair Car', '2S': 'Second Sitting',
  EC: 'Executive Chair Car', EV: 'Vistadome', FC: 'First Class',
};

const Train = z.object({
  board: z.string(),
  boardStation: z.string().optional(),
  deboard: z.string(),
  deboardStation: z.string().optional(),
  departDate: z.iso.date(),
  arrivalDate: z.iso.date(),
  suspended: z.boolean().optional(),
  attributes: z.object({
    number: z.string(),
    localName: z.string(),
    fareClasses: z.array(z.string()).optional(),
    departTime: z.string().regex(/^\d{2}:\d{2}/),
    arrivalTime: z.string().regex(/^\d{2}:\d{2}/),
    bookable: z.boolean().optional(),
  }),
  fares: z.record(z.string(), z.object({ baseFare: z.number() })).optional(),
});
const Between = z.object({ data: z.object({ trainsBetweenStations: z.array(Train) }) });
const Seat = z.object({ c: z.string(), q: z.string(), a: z.string(), f: z.number().optional(), p: z.number().optional() });
const Availability = z.object({ data: z.object({ routesData: z.array(z.object({ trainCode: z.string(), availabilities: z.array(Seat) })) }) });

/** "MANDOVI EXPRESS" as "Mandovi Express"; codes and short words ("NZM ERS SF EXP") stay as ixigo writes them. */
const nameOf = (name: string): string =>
  name.trim().split(/\s+/).map((w) => (/^[A-Z]{4,}$/.test(w) ? `${w[0]}${w.slice(1).toLowerCase()}` : w)).join(' ');

/** "WL42" as "WL 42", "AVAILABLE-0346" as "Available 346". */
function statusOf(a: string): string {
  const t = a.trim();
  const avl = /^(?:AVAILABLE|AVL)[-\s]*0*(\d+)$/i.exec(t);
  if (avl) return `Available ${avl[1]}`;
  const queue = /^(WL|RAC|GNWL|RLWL|PQWL)\s*0*(\d+)$/i.exec(t);
  if (queue) return `${queue[1]!.toUpperCase()} ${queue[2]}`;
  return t.length > 30 ? t.slice(0, 30) : t;
}

const rupeesText = (rupees: number): string => `₹${rupees.toLocaleString('en-IN')}`;

interface TrainClassRead {
  number: string;
  name: string;
  from: { code: string; name: string };
  to: { code: string; name: string };
  departAt: string;
  arriveAt: string;
  departDate: string;
  classCode: string;
  fareRupees: number;
  status?: string;
  chance?: number;
  tatkal?: { status: string; fareRupees?: number };
}

function trainOption(t: TrainClassRead): RecipeOption {
  const minutes = Math.round((Date.parse(t.arriveAt) - Date.parse(t.departAt)) / 60_000);
  return {
    kind: 'train',
    title: `${t.name} ${t.number}`,
    priceMinor: paise(t.fareRupees),
    currency: 'INR',
    priceNote: `per person, ${t.classCode}`,
    journey: {
      mode: 'train',
      origin: { name: t.from.name.slice(0, 80), code: t.from.code },
      destination: { name: t.to.name.slice(0, 80), code: t.to.code },
      depart_at: t.departAt,
      arrive_at: t.arriveAt,
      carrier_name: 'Indian Railways',
      number: t.number,
    },
    highlights: highlights(
      CLASS_WORDS[t.classCode] ?? t.classCode,
      t.status,
      t.chance ? `${Math.round(t.chance)}% chance to confirm` : null,
      t.tatkal ? `Tatkal: ${t.tatkal.status}${t.tatkal.fareRupees ? `, ${rupeesText(t.tatkal.fareRupees)}` : ''}` : minutes > 0 ? hoursMinutes(minutes) : null,
    ),
    facts: {
      class_code: t.classCode,
      ...(t.status ? { availability: t.status } : {}),
      ...(t.chance ? { chance: Math.round(t.chance) } : {}),
      ...(t.tatkal ? { tatkal_availability: t.tatkal.status, ...(t.tatkal.fareRupees ? { tatkal_fare_minor: paise(t.tatkal.fareRupees) } : {}) } : {}),
      ...(minutes > 0 ? { duration_min: minutes } : {}),
    },
    sourceUrl: `${IXIGO}/trains/${t.number}?orgn=${t.from.code}&dstn=${t.to.code}&departDate=${t.departDate}&quota=GN`,
  };
}

function extract(captures: Capture[]): RecipeOption[] {
  const list = bodiesFor(captures, BETWEEN)[0];
  if (list === undefined) throw new TravelError('refused', "ixigo's train results page did not load its trains.");
  const seats = new Map<string, z.infer<typeof Seat>[]>();
  const availability = bodiesFor(captures, AVAILABILITY)[0];
  // Seat status is extra: without it the trains still show, with their fares.
  if (availability !== undefined) {
    for (const r of readBody(Availability, availability, 'train availability').data.routesData) seats.set(r.trainCode, r.availabilities);
  }
  const out: RecipeOption[] = [];
  for (const t of readBody(Between, list, 'the train search').data.trainsBetweenStations) {
    if (t.suspended || t.attributes.bookable === false) continue;
    const mine = seats.get(t.attributes.number) ?? [];
    const classes = [...new Set([...(t.attributes.fareClasses ?? []), ...Object.keys(t.fares ?? {})])];
    for (const c of classes) {
      const gn = mine.find((x) => x.c === c && x.q === 'GN');
      const tq = mine.find((x) => x.c === c && x.q === 'TQ');
      const fare = gn?.f || t.fares?.[c]?.baseFare;
      if (!fare) continue;
      out.push(trainOption({
        number: t.attributes.number,
        name: nameOf(t.attributes.localName),
        from: { code: t.board, name: t.boardStation ?? t.board },
        to: { code: t.deboard, name: t.deboardStation ?? t.deboard },
        departAt: istAt(t.departDate, t.attributes.departTime),
        arriveAt: istAt(t.arrivalDate, t.attributes.arrivalTime),
        departDate: t.departDate,
        classCode: c,
        fareRupees: fare,
        ...(gn ? { status: statusOf(gn.a) } : {}),
        ...(gn?.p ? { chance: gn.p } : {}),
        ...(tq ? { tatkal: { status: statusOf(tq.a), ...(tq.f ? { fareRupees: tq.f } : {}) } } : {}),
      }));
    }
  }
  return out;
}

/**
 * Reads the train cards from the page text: "10103MANDOVI EXPRESS", the boarding station, time and day, the arrival
 * station, time and day, then each class with its fare, status and chance. It runs in the page, sent as its source, so
 * it uses nothing outside itself.
 */
export function readTrainsPage(text: string): unknown[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const isTrain = (l: string): boolean => /^\d{5}\D.+$/.test(l) && !/running status/i.test(l);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTrain(lines[i]!)) continue;
    let end = i + 1;
    while (end < lines.length && !isTrain(lines[end]!)) end++;
    const card = lines.slice(i + 1, end);
    const codes = card.filter((l) => /^[A-Z]{2,5}$/.test(l) && !/^(SL|CC|EC|EV|FC|[123][AES]|2S)$/.test(l));
    const times = card.filter((l) => /^\d{2}:\d{2}$/.test(l));
    const days = card.filter((l) => /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}$/.test(l));
    if (codes.length < 2 || times.length < 2 || days.length < 2) continue;
    const isClass = (l: string): boolean => /^(SL|CC|EC|EV|FC|1A|2A|3A|3E|2S)$/.test(l);
    const classes: Array<Record<string, unknown>> = [];
    for (let k = 0; k < card.length - 2; k++) {
      if (!isClass(card[k]!) || !/^₹?\d[\d,]*$/.test(card[k + 1]!)) continue;
      // The class's own lines: its status, then what ixigo adds, up to the next class.
      let stop = k + 2;
      while (stop < Math.min(k + 6, card.length) && (stop === k + 2 || !isClass(card[stop]!))) stop++;
      const chance = card.slice(k + 2, stop).map((l) => /^(\d{1,3})% chance/i.exec(l)).find((m) => m);
      classes.push({ c: card[k], fare: Number(card[k + 1]!.replace(/[₹,]/g, '')), status: card[k + 2]!.slice(0, 30), chance: chance ? Number(chance[1]) : null });
    }
    if (classes.length === 0) continue;
    const m = /^(\d{5})(.+)$/.exec(lines[i]!)!;
    rows.push({ number: m[1], name: m[2]!.trim().slice(0, 60), from: codes[0], depart: times[0], depart_day: days[0], to: codes[1], arrive: times[1], arrive_day: days[1], classes: classes.slice(0, 6) });
  }
  return rows;
}

const Clock = z.string().regex(/^\d{2}:\d{2}$/);
const Day = z.string().regex(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}$/);
const TrainRow = z.object({
  number: z.string().regex(/^\d{5}$/),
  name: z.string().min(1).max(60),
  from: z.string().regex(/^[A-Z]{2,5}$/),
  depart: Clock,
  depart_day: Day,
  to: z.string().regex(/^[A-Z]{2,5}$/),
  arrive: Clock,
  arrive_day: Day,
  classes: z.array(z.object({ c: z.string().max(4), fare: z.number().positive(), status: z.string().max(30), chance: z.number().min(0).max(100).nullable() })).min(1).max(6),
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sat, 7 Nov" near the searched date as 2026-11-07 (a day before the search, in January, is next year's). */
function dayOf(text: string, searched: string): string {
  const m = /, (\d{1,2}) ([A-Z][a-z]{2})$/.exec(text)!;
  const month = MONTHS.indexOf(m[2]!) + 1;
  if (month === 0) throw new TravelError('refused', `ixigo's page showed a day Go does not read: ${text}`);
  const year = Number(searched.slice(0, 4));
  const day = (y: number): string => `${y}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return day(year) < addDays(searched, -2) ? day(year + 1) : day(year);
}

function fromAgent(rows: unknown, s: TrainSlots): RecipeOption[] {
  return readRows(z.array(TrainRow), rows, 'trains').flatMap((r) => {
    const departDate = dayOf(r.depart_day, s.date);
    return r.classes.map((c) =>
      trainOption({
        number: r.number,
        name: nameOf(r.name),
        from: { code: r.from, name: r.from },
        to: { code: r.to, name: r.to },
        departAt: istAt(departDate, r.depart),
        arriveAt: istAt(dayOf(r.arrive_day, s.date), r.arrive),
        departDate,
        classCode: c.c,
        fareRupees: c.fare,
        status: statusOf(c.status),
        ...(c.chance ? { chance: c.chance } : {}),
      }),
    );
  });
}

export const trains: Recipe<TrainSlots> = {
  id: 'ixigo.trains',
  kind: 'trains',
  slotsFrom(q: TravelQuery) {
    if (!q.from || !q.to || !q.date) throw new TravelError('needs_more', 'A train search needs where from, where to and the date.');
    return { from: stationOf(q.from).code, to: stationOf(q.to).code, date: q.date };
  },
  url: (s) => `${IXIGO}/search/result/train/${s.from}/${s.to}/${ddmmyyyy(s.date)}//1/0/0/0/ALL`,
  capture: [
    { match: BETWEEN, required: true },
    { match: AVAILABILITY, required: false },
  ],
  fetchable: true,
  readyText: 'SHOW AVAILABILITY',
  extract,
  agentExtractor: pageScript(readTrainsPage, 2),
  fromAgent,
  ttlMs: RECIPE_TTL_MS,
};

/**
 * A person's own train, booked on ixigo as their flight is (flight-booking.ts; Keshav, 11 Oct: "trains and buses are crying
 * to get booked like flights"). What a train's booking reads and says, apart from the run: the day's results page its
 * option leads to, the class's seats and fare now, in plain words, and a passenger's age on the day they travel.
 *
 * A train option's own address is the train's page (/trains/{n}?orgn&dstn&departDate&quota), whose one BOOK needs a class
 * and a date chosen from a strip of the next few days (p0's T1, 11 Oct): a booking starts from the day's search results.
 */

import type { FetchPlan } from '../recipes/recipe.js';
import type { TitleShape } from './flight-booking.js';

/** ixigo's own call for the seats on a day's train results: each train's classes and quotas, their status and fare. */
export const TRAIN_AVAILABILITY = '/api/v3/trains/availability';

/** The train's number, its stations and its day (YYYY-MM-DD), from a train option's own address; null for anything else. */
export function trainOf(sourceUrl: string | null | undefined): { number: string; from: string; to: string; date: string; quota: string } | null {
  if (!sourceUrl) return null;
  let u: URL;
  try {
    u = new URL(sourceUrl);
  } catch {
    return null;
  }
  const n = /^\/trains\/(\d{4,5})$/.exec(u.pathname)?.[1];
  const from = u.searchParams.get('orgn');
  const to = u.searchParams.get('dstn');
  const date = u.searchParams.get('departDate');
  if (!n || !from || !to || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { number: n, from, to, date, quota: u.searchParams.get('quota') ?? 'GN' };
}

/** The day's train results on ixigo for a train option, for its class: /search/result/train/{FROM}/{TO}/{DDMMYYYY}//1/0/0/0/{CLASS}. */
export function trainResultsAddress(sourceUrl: string | null | undefined, classCode: string | null): string | null {
  const t = trainOf(sourceUrl);
  if (!t) return null;
  const [y, m, d] = t.date.split('-');
  return `https://www.ixigo.com/search/result/train/${t.from}/${t.to}/${d}${m}${y}//1/0/0/0/${classCode ?? 'ALL'}`;
}

/** A class's seats and fare now: ixigo's status ("AVAILABLE 34", "RAC 5", "WL 12"), its chance a waitlist confirms, the fare. */
export interface ClassNow {
  status: string;
  /** ixigo's chance in % that a waitlisted ticket confirms; null when it gives none (or it is available). */
  chance: number | null;
  /** Per person, in paise, IRCTC's charges in. */
  fareMinor: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The class on that train and quota, from the results page's own seats call (data.routesData[]{trainCode,
 * availabilities[]{c, q, a, p, f}}, the atlas's trains.md): null when the call has no such train, class or quota.
 */
export function classNow(body: unknown, train: string, classCode: string, quota: string): ClassNow | null {
  const routes = isObject(body) && isObject(body['data']) && Array.isArray(body['data']['routesData']) ? body['data']['routesData'] : [];
  for (const r of routes) {
    if (!isObject(r) || String(r['trainCode']) !== train || !Array.isArray(r['availabilities'])) continue;
    for (const a of r['availabilities']) {
      if (!isObject(a) || a['c'] !== classCode || (a['q'] ?? 'GN') !== quota || typeof a['a'] !== 'string') continue;
      const p = typeof a['p'] === 'number' && a['p'] > 0 ? a['p'] : null;
      const f = typeof a['f'] === 'number' && a['f'] > 0 ? Math.round(a['f'] * 100) : null;
      return { status: a['a'].trim(), chance: p, fareMinor: f };
    }
  }
  return null;
}

/** Waitlisted or RAC: said plainly before they pay (the lead, 11 Oct). Null when seats are available. */
export function seatWords(now: Pick<ClassNow, 'status' | 'chance'>): string | null {
  const s = now.status.toUpperCase();
  const chance = now.chance !== null ? `; ixigo gives it a ${now.chance}% chance to confirm` : '';
  // Every waitlist ixigo shows: WL 12, GNWL 12, TQWL12, RLWL 3.
  if (/WL\s*\d|\bWL\b/.test(s)) return `It's waitlisted (${now.status})${chance}: a waitlisted ticket that doesn't confirm by the chart is cancelled and refunded.`;
  if (/\bRAC\b/.test(s)) return `It's RAC (${now.status}): you travel on a shared side berth until a full berth frees up${chance}.`;
  if (/REGRET|NOT AVAILABLE|TRAIN CANCELLED|DEPARTED/.test(s)) return `ixigo says ${now.status.toLowerCase()} for it now.`;
  return null;
}

/** Whole years from a YYYY-MM-DD birthday to a YYYY-MM-DD day; null for either not a date. */
export function ageOn(dob: string, day: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!b || !t) return null;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const [ty, tm, td] = [Number(t[1]), Number(t[2]), Number(t[3])];
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return age >= 0 && age < 130 ? age : null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day (YYYY-MM-DD) as the results page's list of dates under a class writes it: "Fri, 06 Nov" (p0's T1). */
export function dayLabel(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Fixed names: a locale's own may write "Sept", where the page writes "Sep".
  return `${WEEKDAYS[at.getUTCDay()]}, ${m[3]} ${MONTHS[at.getUTCMonth()]}`;
}

/** One passenger as ixigo's train form takes them: their name as on their ID, age on the day, gender, IRCTC user ID. */
export interface TrainPassenger { name: string; age: number; gender: 'male' | 'female'; irctc: string }

/**
 * ixigo's train passenger form, typed for one passenger, its Gender as one shape (a select, which takes its option typed
 * in; chips or buttons; radios), by the usual labels. Nobody has mapped the page behind the login (p0's T1 stopped at ixigo's
 * login, logged out): a box not found ends the fetch before anything is submitted, and the next shape is tried.
 */
export function trainPassengerSteps(p: TrainPassenger, shape: TitleShape): NonNullable<FetchPlan['steps']> {
  const gender = p.gender === 'male' ? 'Male' : 'Female';
  const genderStep: NonNullable<FetchPlan['steps']>[number] = shape === 'select'
    ? { op: 'type', role: 'combobox', name: 'Gender', text: gender }
    : { op: 'click', role: shape === 'chips' ? 'button' : 'radio', name: gender };
  return [
    { op: 'type', role: 'textbox', name: 'Name', text: p.name },
    { op: 'type', role: 'textbox', name: 'Age', text: String(p.age) },
    genderStep,
    { op: 'type', role: 'textbox', name: 'IRCTC Username', text: p.irctc },
  ];
}

/**
 * When a person can leave, from their own words (Person.earliest_leave, their words or a chip: "Fri after 6 pm",
 * "6 ke baad", "Friday evening", "subah"), as a window for a flight on a day: departAfter and departBefore, 24-hour, as
 * Go's own checks take them (filters.ts). English and Hinglish, by rule, never a model.
 *
 * Words that name another day than the flight's set no window: that day's limit is not this one's. Words with no time
 * in them ("whenever", "Friday") set none. Words it can't read set none and say so (unread), for the line to say.
 */

export type LeaveWindow =
  | { kind: 'any' }
  | { kind: 'window'; departAfter?: string; departBefore?: string; words: string }
  | { kind: 'unread'; text: string };

/** Each weekday by its number (0 Sunday), in English and Hindi as people type them. */
const DAYS: Array<[number, RegExp]> = [
  [0, /\b(sun|sunday|ravivar|raviwar|itwar|itvaar|itwaar)\b/],
  [1, /\b(mon|monday|somvar|somwar)\b/],
  [2, /\b(tue|tues|tuesday|mangalvar|mangalwar)\b/],
  [3, /\b(wed|wednesday|budhvar|budhwar)\b/],
  [4, /\b(thu|thur|thurs|thursday|guruvar|guruwar|brihaspativar)\b/],
  [5, /\b(fri|friday|shukravar|shukrawar|shukarvar)\b/],
  [6, /\b(sat|saturday|shanivar|shaniwar)\b/],
];
const ANY = /\b(any ?time|whenever|flexible|kabhi bhi|jab bhi|koi bhi|all day|free)\b/;
const BEFORE = /\b(before|by|until|till|tak|pehle|pahle)\b/;
const PM_WORDS = /\b(pm|p\.m|evening|shaam|sham|night|raat|office|work|kaam)\b/;
const AM_WORDS = /\b(am|a\.m|morning|subah|subha|savere|sawere)\b/;
/** A time: "6", "6 pm", "6:30pm", "18:00", "6 baje"; never a date's day ("6 Nov", "13/11"). */
const TIME = /(?<![\d/])(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|baje)?(?![\d/])(?!\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|st\b|nd\b|rd\b|th\b))/g;
/** Parts of the day with no number: the window each means. */
const PARTS: Array<[RegExp, { departAfter?: string; departBefore?: string }]> = [
  [/\b(after (office|work)|(office|kaam) ke ?baad)\b/, { departAfter: '18:00' }],
  [/\b(late night|der raat)\b/, { departAfter: '22:00' }],
  [/\b(night|raat)\b/, { departAfter: '20:00' }],
  [/\b(evening|shaam|sham)\b/, { departAfter: '17:00' }],
  [/\b(afternoon|dopahar|dophar|dopaher)\b/, { departAfter: '12:00', departBefore: '17:00' }],
  [/\b(morning|subah|subha|savere|sawere)\b/, { departBefore: '12:00' }],
];

const pad = (n: number): string => String(n).padStart(2, '0');

/** "18:00" as people say it: "6 pm", "6:30 pm", "noon". */
export function spokenClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (h === 12 && m === 0) return 'noon';
  if (h === 0 && m === 0) return 'midnight';
  return `${h % 12 || 12}${m ? `:${pad(m)}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

function wordsOf(w: { departAfter?: string; departBefore?: string }): string {
  if (w.departAfter && w.departBefore) return `${spokenClock(w.departAfter)} to ${spokenClock(w.departBefore)}`;
  return w.departAfter ? `after ${spokenClock(w.departAfter)}` : `before ${spokenClock(w.departBefore!)}`;
}

/** An hour as a 24-hour one: am or pm when said, else by the words around it, else 1 to 7 is the evening. */
function hourOf(h: number, meridiem: string | undefined, text: string): number | null {
  if (h > 23) return null;
  const m = (meridiem ?? '').replace(/\./g, '');
  if (m === 'pm') return h === 12 ? 12 : h > 12 ? null : h + 12;
  if (m === 'am') return h === 12 ? 0 : h > 12 ? null : h;
  if (h >= 13 || h === 0) return h;
  if (AM_WORDS.test(text)) return h === 12 ? 0 : h;
  if (PM_WORDS.test(text)) return h === 12 ? 12 : h + 12;
  return h <= 7 ? h + 12 : h;
}

/** The window a person's leaving words set for a flight on day (YYYY-MM-DD). */
export function leaveWindow(words: string | null | undefined, day: string): LeaveWindow {
  const said = (words ?? '').trim();
  if (said === '') return { kind: 'any' };
  const text = said.toLowerCase();
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const named = DAYS.filter(([, re]) => re.test(text)).map(([n]) => n);
  // Another day's limit: on the flight's day they may leave any time.
  if (named.length > 0 && !named.includes(weekday)) return { kind: 'any' };
  const times: string[] = [];
  for (const m of text.matchAll(TIME)) {
    const h = hourOf(Number(m[1]), m[3] === 'baje' ? undefined : m[3], text);
    const min = m[2] ? Number(m[2]) : 0;
    if (h === null || min > 59) continue;
    times.push(`${pad(h)}:${pad(min)}`);
  }
  if (times.length >= 2) {
    // A range ("between 2 and 6 pm", "2-6 pm", "2 se 6"): the later hour is the evening one when only it says so.
    const [a, b] = [times[0]!, times[1]!];
    const w = a < b ? { departAfter: a, departBefore: b } : { departAfter: a };
    return { kind: 'window', ...w, words: wordsOf(w) };
  }
  if (times.length === 1) {
    const w = BEFORE.test(text) ? { departBefore: times[0]! } : { departAfter: times[0]! };
    return { kind: 'window', ...w, words: wordsOf(w) };
  }
  const part = PARTS.find(([re]) => re.test(text));
  if (part) return { kind: 'window', ...part[1], words: wordsOf(part[1]) };
  if (ANY.test(text) || named.length > 0) return { kind: 'any' };
  return { kind: 'unread', text: said };
}

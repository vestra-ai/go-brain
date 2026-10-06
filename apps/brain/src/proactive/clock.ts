// Time in the trip's own time zone: the local hour and day, and "8 am tomorrow" as a real instant.
export const DEFAULT_TZ = 'Asia/Kolkata';
export const NIGHT_FROM_HOUR = 22;
export const NIGHT_UNTIL_HOUR = 8;

/** Runs `fn` after `ms`; returns a cancel. Injected everywhere so tests move time by hand. */
export type Schedule = (fn: () => void, ms: number) => () => void;
export const realSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(tz, f);
  }
  return f;
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }
function parts(at: Date, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of format(tz).formatToParts(at)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { year: out.year ?? 1970, month: out.month ?? 1, day: out.day ?? 1, hour: out.hour ?? 0, minute: out.minute ?? 0, second: out.second ?? 0 };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localHour(at: Date, tz: string): number {
  return parts(at, tz).hour;
}

export function localDay(at: Date, tz: string): string {
  const p = parts(at, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes the zone is ahead of UTC at that instant (330 for India). */
export function offsetMinutes(at: Date, tz: string): number {
  const p = parts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant when the clock on the wall in `tz` shows `hour:minute` on `day` (YYYY-MM-DD). */
export function zonedTime(day: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let t = wall - offsetMinutes(new Date(wall), tz) * 60_000;
  t = wall - offsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isNight(at: Date, tz: string): boolean {
  const h = localHour(at, tz);
  return h >= NIGHT_FROM_HOUR || h < NIGHT_UNTIL_HOUR;
}

/** 8 am local: today's if it is still before 8, else tomorrow's. */
export function nextMorning(at: Date, tz: string): Date {
  const day = localDay(at, tz);
  return zonedTime(localHour(at, tz) < NIGHT_UNTIL_HOUR ? day : addDays(day, 1), NIGHT_UNTIL_HOUR, 0, tz);
}

/** 8 am local tomorrow: a spent daily budget is fresh again and it is not night. */
export function tomorrowMorning(at: Date, tz: string): Date {
  return zonedTime(addDays(localDay(at, tz), 1), NIGHT_UNTIL_HOUR, 0, tz);
}

/** "Fri, 6 Nov, 8:45 pm" in the trip's zone, for Go's own words. */
export function localWhen(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

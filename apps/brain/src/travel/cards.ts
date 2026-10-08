/**
 * The options card and the small words on it: prices in rupees the Indian way, clocks as people say them, and no
 * em or en dashes in anything a person sees (master §7).
 */
import * as C from '@go/contract';
import type { z } from 'zod';
import type { OptionKind, ResultOption } from './results.js';

export type OptionsCardT = z.infer<typeof C.OptionsCard>;
export type NoticeCardT = z.infer<typeof C.NoticeCard>;
type CardOption = OptionsCardT['options'][number];

export const PICK_ACTION = { action_id: 'pick', label: "I'll take this", style: 'primary', per_option: true } as const;
export const VOTE_ACTION = { action_id: 'vote', label: 'Put it to a vote', style: 'secondary' } as const;
/** On options from ixigo.com: opens the option's own page there, where the group books it. */
export const OPEN_ACTION = { action_id: 'open', label: 'See on ixigo', style: 'secondary', per_option: true } as const;
/** On a card of stays that shows a few of a longer list: the whole list on ixigo.com, one tap away. */
export const SEE_ALL_ACTION = { action_id: 'see_all', label: 'See all on ixigo', style: 'secondary' } as const;

/** On the card of each home city's ways to the trip: ixigo's flights from the tapper's own home city. */
export const FLIGHTS_HOME_ACTION = { action_id: 'flights_home', label: 'Flights from my city', style: 'secondary' } as const;

/** On the card that links to flights on ixigo, when Go can't read them itself. */
export const SEE_FLIGHTS_ACTION = { action_id: 'see_on_ixigo', label: 'See flights on ixigo', style: 'primary' } as const;

/**
 * The flights Go couldn't read, as a link: ixigo's results page with what people asked for already set, and who it is
 * set for ("for 3 from Delhi"). It never says there are no flights: ixigo refused Go's computer, and the page has them.
 */
export function buildFlightsLinkCard(i: { cardId: string; title: string; url: string; who?: string | null }): NoticeCardT {
  const set = i.who ? `set ${i.who}, with what you asked for` : 'with what you asked for already set';
  return C.NoticeCard.parse({
    card_id: i.cardId,
    kind: 'notice',
    fallback_text: clip(`${i.title}${i.who ? `, ${i.who}` : ''}: see them on ixigo`, 300),
    tone: 'info',
    title: clip(i.title, 80),
    body: `Go can't read ixigo's flights from its computer right now, so here they are on ixigo, ${set}. Book them there.`,
    source: { name: 'ixigo', url: i.url },
    actions: [SEE_FLIGHTS_ACTION],
  });
}

/** ixigo's own search page for each kind of search: where the group searches a place Go has no code for. */
export const IXIGO_SEARCH_PAGES = {
  flights: { url: 'https://www.ixigo.com/flights', noun: 'flights' },
  trains: { url: 'https://www.ixigo.com/trains', noun: 'trains' },
  buses: { url: 'https://www.ixigo.com/buses', noun: 'buses' },
  stays: { url: 'https://www.ixigo.com/hotels', noun: 'hotels' },
} as const;

/** The card for a search Go has no ixigo code for: ixigo's own page for that kind of search, to search it there. */
export function buildIxigoPageCard(i: { cardId: string; title: string; kind: keyof typeof IXIGO_SEARCH_PAGES }): NoticeCardT {
  const page = IXIGO_SEARCH_PAGES[i.kind];
  return C.NoticeCard.parse({
    card_id: i.cardId,
    kind: 'notice',
    fallback_text: clip(`${i.title}: search it on ixigo`, 300),
    tone: 'info',
    title: clip(i.title, 80),
    body: `Search it on ixigo's ${page.noun} page, and book it there.`,
    source: { name: 'ixigo', url: page.url },
    actions: [{ ...SEE_FLIGHTS_ACTION, label: `See ${page.noun} on ixigo` }],
  });
}

/** The kinds of place a stays title or vote can name. ixigo.com's results carry no kind, so a name has to say it. */
const PLACE_KINDS = /\b(villa|resort|hotel|homestay|apartment|cottage)s?\b/i;

/** The kind of place the words name ("Pool villas", "Which villa?") when not every option's own name says it; else null. */
export function placeKindNotAll(words: string, names: string[]): string | null {
  const kind = PLACE_KINDS.exec(words)?.[1]?.toLowerCase();
  if (!kind) return null;
  return names.every((n) => new RegExp(`\\b${kind}`, 'i').test(n)) ? null : kind;
}

/** The option's own https page on ixigo.com, or null: the only pages "See on ixigo" opens. */
export function ixigoPage(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  try {
    const u = new URL(sourceUrl);
    return u.protocol === 'https:' && (u.hostname === 'ixigo.com' || u.hostname.endsWith('.ixigo.com')) ? u.toString() : null;
  } catch {
    return null;
  }
}

export function plain(text: string): string {
  // A number range keeps its meaning as a hyphen ("6–9 Nov" is "6-9 Nov"), as sanitize() does; any other dash is a comma.
  return text.replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
}

export function clip(text: string, max: number): string {
  const t = plain(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function formatInr(minor: number): string {
  const rupees = minor / 100;
  const digits = Number.isInteger(rupees) ? 0 : 2;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "HH:MM" where the journey happens: as written when the time carries an offset, else in India. */
export function localClock(iso: string, timeZone = 'Asia/Kolkata'): string {
  const m = /T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:\d{2}$/.exec(iso);
  if (m) return `${m[1]}:${m[2]}`;
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** The date of a journey time where it happens ("2026-11-08"): as written when the time carries an offset, else in India. */
export function localDate(iso: string, timeZone = 'Asia/Kolkata'): string {
  const m = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:\d{2}$/.exec(iso);
  if (m) return m[1]!;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** How many days after it leaves a journey arrives, by the date at each end where it happens. */
export function daysLater(departAt: string, arriveAt: string): number {
  return Math.round((Date.parse(`${localDate(arriveAt)}T00:00:00Z`) - Date.parse(`${localDate(departAt)}T00:00:00Z`)) / 86_400_000);
}

/**
 * What follows the arrival clock: nothing on the same day, "next day" on the day after, and the day itself when it is
 * later still ("on Sun 8 Nov"): a 27-hour train is never "next day".
 */
export function arrivalWords(departAt: string, arriveAt: string, nextDay = 'next day'): string {
  const later = daysLater(departAt, arriveAt);
  if (later === 1) return ` ${nextDay}`;
  if (later < 2) return '';
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${localDate(arriveAt)}T00:00:00Z`));
  return ` on ${day.replace(',', '')}`;
}

export function formatClock(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${hhmm.slice(3, 5)} ${h < 12 ? 'am' : 'pm'}`;
}

export const CLASS_WORDS: Record<string, string> = { '1A': 'AC First Class', '2A': 'AC 2 Tier', '3A': 'AC 3 Tier', SL: 'Sleeper', CC: 'AC Chair Car', '2S': 'Second Sitting' };

export function subtitleFor(o: ResultOption): string | null {
  if (o.subtitle) return o.subtitle;
  if (o.journey) {
    const j = o.journey;
    let extra: string | null = null;
    if (o.kind === 'flight' && typeof j.stops === 'number') extra = j.stops === 0 ? 'non-stop' : `${j.stops} stop`;
    if (o.kind === 'train' && typeof o.facts.class_code === 'string') extra = CLASS_WORDS[o.facts.class_code] ?? o.facts.class_code;
    if (o.kind === 'bus' && typeof o.facts.bus_type === 'string') extra = o.facts.bus_type;
    return `${formatClock(localClock(j.depart_at))} to ${formatClock(localClock(j.arrive_at))}${arrivalWords(j.depart_at, j.arrive_at)}${extra ? `, ${extra}` : ''}`;
  }
  if (o.kind === 'stay') {
    const area = typeof o.facts.area === 'string' ? o.facts.area : null;
    const nights = typeof o.facts.nights === 'number' ? o.facts.nights : null;
    const total = o.totalMinor !== undefined && nights ? `${formatInr(o.totalMinor)} for ${nights} night${nights === 1 ? '' : 's'}` : null;
    const words = [area, total].filter((x): x is string => x !== null).join(', ');
    return words || null;
  }
  return o.why ?? null;
}

export interface CardPick { optionId: string; option: ResultOption; imageUrl: string | null }

function cardOption(p: CardPick): CardOption {
  const o = p.option;
  const subtitle = subtitleFor(o);
  return {
    option_id: p.optionId,
    title: clip(o.title, 80),
    ...(subtitle ? { subtitle: clip(subtitle, 120) } : {}),
    ...(p.imageUrl ? { image_url: p.imageUrl } : {}),
    ...(o.priceMinor !== undefined ? { price_minor: o.priceMinor, currency: o.currency ?? 'INR' } : {}),
    ...(o.priceNote ? { price_note: clip(o.priceNote, 40) } : {}),
    highlights: o.highlights.map((h) => clip(h, 40)).filter((h) => h.length > 0).slice(0, 4),
    ...(o.journey ? { journey: o.journey } : {}),
    ...(o.place ? { place: { ...o.place, name: clip(o.place.name, 120), ...(o.place.address ? { address: clip(o.place.address, 200) } : {}) } } : {}),
    ...(o.rating !== undefined ? { rating: Math.min(5, Math.max(0, o.rating)) } : {}),
    ...(o.refundableUntil ? { refundable_until: o.refundableUntil } : {}),
  };
}

const KIND_WORDS: Record<OptionKind, [string, string]> = {
  stay: ['stay', 'stays'], flight: ['flight', 'flights'], train: ['train', 'trains'], bus: ['bus', 'buses'],
  place: ['place', 'places'], food: ['place to eat', 'places to eat'], activity: ['thing to do', 'things to do'],
  cab: ['cab', 'cabs'],
};

/** The options card, checked against the contract: a bug here throws instead of posting a card the App cannot draw. */
/** seeAll: the card's last button opens the whole list on ixigo.com instead of each option's page (stays, three shown). */
export function buildOptionsCard(i: { cardId: string; title: string; optionKind: OptionKind; checkedAt: string; picks: CardPick[]; seeAll?: boolean }): OptionsCardT {
  const priced = i.picks.filter((p) => p.option.priceMinor !== undefined);
  const cheapest = [...priced].sort((a, b) => (a.option.priceMinor ?? 0) - (b.option.priceMinor ?? 0))[0];
  const from = cheapest ? `, from ${formatInr(cheapest.option.priceMinor ?? 0)}${cheapest.option.priceNote ? ` ${cheapest.option.priceNote}` : ''}` : '';
  const [one, many] = KIND_WORDS[i.optionKind];
  return C.OptionsCard.parse({
    card_id: i.cardId,
    kind: 'options',
    fallback_text: clip(`${i.picks.length} ${i.picks.length === 1 ? one : many}: ${i.title}${from}`, 300),
    title: clip(i.title, 80),
    option_kind: i.optionKind,
    checked_at: i.checkedAt,
    options: i.picks.map(cardOption),
    actions: [PICK_ACTION, ...(i.picks.length >= 2 ? [VOTE_ACTION] : []), ...(i.seeAll ? [SEE_ALL_ACTION] : i.picks.some((p) => ixigoPage(p.option.sourceUrl)) ? [OPEN_ACTION] : [])],
  });
}

/**
 * The card of each home city's ways to the trip: its rows are trains and buses, each with its own ixigo page; flights:
 * "Flights from my city" opens the tapper's own city's flights. Checked against the contract like any options card.
 */
export function buildWaysCard(i: { cardId: string; title: string; homes: string[]; checkedAt: string; picks: CardPick[]; flights: boolean }): OptionsCardT {
  const homes = i.homes.length < 2 ? (i.homes[0] ?? '') : `${i.homes.slice(0, -1).join(', ')} and ${i.homes.at(-1)}`;
  return C.OptionsCard.parse({
    card_id: i.cardId,
    kind: 'options',
    fallback_text: clip(`${i.title}: the cheapest and the fastest from ${homes}`, 300),
    title: clip(i.title, 80),
    option_kind: i.picks.every((p) => p.option.kind === 'bus') ? 'bus' : 'train',
    checked_at: i.checkedAt,
    options: i.picks.map(cardOption),
    actions: [OPEN_ACTION, ...(i.flights ? [FLIGHTS_HOME_ACTION] : [])],
  });
}

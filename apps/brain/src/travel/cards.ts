/**
 * The options card and the small words on it: prices in rupees the Indian way, clocks as people say them, and no
 * em or en dashes in anything a person sees (master §7).
 */
import * as C from '@go/contract';
import type { z } from 'zod';
import type { OptionDetailsT } from './details.js';
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
/**
 * The App's budget sheet for a trip, from the App team's route table (docs/guide/11-contract-1-1.md): since rev 4 the
 * group's one budget. No card asks for a budget any more (rev 4: nobody gives a private one); a stays card from before
 * still opens it from its "Add my budget" (taps.ts).
 */
export const budgetSheet = (tripId: string): string => `go://trips/${encodeURIComponent(tripId)}/sheet/budget`;

/**
 * A ticket is its traveller's own (Keshav, 10 Oct: "why would we need everyone to vote for my ticket lol"): a flight,
 * train or bus fare is confirmed by the person it is for, alone, never put to the group. Shared things (a stay, a cab, an
 * activity) still go to a vote. Its cards have no "Put it to a vote", and a pick on one posts that person's own confirm.
 */
export const PERSONAL_KINDS: ReadonlySet<OptionKind> = new Set<OptionKind>(['flight', 'train', 'bus']);

/** On a person's own confirm: "Book it" and "Change", for them alone. */
export const BOOK_MINE = 'book_mine';
export const CHANGE_MINE = 'change';

/**
 * One person's own confirm of the ticket they picked: the option itself, "Book IndiGo 6E2150 for you, ₹11,571?", with
 * "Book it" and "Change" that only they see. The room sees the card; it names them (for_person_ids), so it is pinned for
 * them until settled.
 */
export function buildConfirmMineCard(i: { cardId: string; personId: string; optionKind: OptionKind; checkedAt: string; option: CardOption }): OptionsCardT {
  const price = typeof i.option.price_minor === 'number' ? `, ${formatInr(i.option.price_minor)}` : '';
  const ask = `Book ${i.option.title} for you${price}?`;
  const only = [i.personId];
  return C.OptionsCard.parse({
    card_id: i.cardId,
    kind: 'options',
    fallback_text: clip(ask, 300),
    title: clip(ask, 80),
    option_kind: i.optionKind,
    checked_at: i.checkedAt,
    options: [i.option],
    for_person_ids: only,
    actions: [
      { action_id: BOOK_MINE, label: 'Book it', style: 'primary', per_option: true, only_for_person_ids: only },
      { action_id: CHANGE_MINE, label: 'Change', style: 'secondary', per_option: true, only_for_person_ids: only },
    ],
  });
}

/** On the card of each home city's ways to the trip: ixigo's flights from the tapper's own home city. */
export const FLIGHTS_HOME_ACTION = { action_id: 'flights_home', label: 'Flights from my city', style: 'secondary' } as const;

/** On the card that links to flights on ixigo, when Go can't read them itself. */
export const SEE_FLIGHTS_ACTION = { action_id: 'see_on_ixigo', label: 'See flights on ixigo', style: 'primary' } as const;
export const SEE_STAYS_ACTION = { action_id: 'see_on_ixigo', label: 'See stays on ixigo', style: 'primary' } as const;

/**
 * The flights (or stays) Go couldn't read, as a link: ixigo's results page with what people asked for already set, and
 * who it is set for ("for 3 from Delhi"). It never says there are none: ixigo refused Go's computer, and the page has them.
 */
export function buildFlightsLinkCard(i: { cardId: string; title: string; url: string; who?: string | null; kind?: 'flights' | 'stays' }): NoticeCardT {
  const set = i.who ? `set ${i.who}, with what you asked for` : 'with what you asked for already set';
  const noun = i.kind === 'stays' ? 'stays' : 'flights';
  return C.NoticeCard.parse({
    card_id: i.cardId,
    kind: 'notice',
    fallback_text: clip(`${i.title}${i.who ? `, ${i.who}` : ''}: see them on ixigo`, 300),
    tone: 'info',
    title: clip(i.title, 80),
    body: `Go can't read ixigo's ${noun} from its computer right now, so here they are on ixigo, ${set}. Book them there.`,
    source: { name: 'ixigo', url: i.url },
    actions: [noun === 'stays' ? SEE_STAYS_ACTION : SEE_FLIGHTS_ACTION],
  });
}

/** On a card that opens one of ixigo's pages for the person to use there themselves. */
export const OPEN_ON_IXIGO_ACTION = { action_id: 'see_on_ixigo', label: 'Open on ixigo', style: 'primary' } as const;

/** A recipe's link (book/tool.ts): ixigo's own page, which the person opens and uses on their own phone (a PNR's status). */
export function buildIxigoLinkCard(i: { cardId: string; title: string; url: string }): NoticeCardT {
  return C.NoticeCard.parse({
    card_id: i.cardId,
    kind: 'notice',
    fallback_text: clip(`${i.title}: open it on ixigo`, 300),
    tone: 'info',
    title: clip(i.title, 80),
    body: 'It opens on ixigo, to check there on your own phone.',
    source: { name: 'ixigo', url: i.url },
    actions: [OPEN_ON_IXIGO_ACTION],
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
    // The card's price is the whole stay (cardOption), so the night's goes here, as its source said it: "₹12,800 per
    // night", "₹9,000 per night, per room, IXIFIRST applied".
    const nightly = o.priceMinor !== undefined ? `${formatInr(o.priceMinor)} ${o.priceNote ?? 'a night'}` : null;
    const words = [area, nightly, shareWords(o)].filter((x): x is string => x !== null).join(', ');
    return words || null;
  }
  return o.why ?? null;
}

/** details: the option's sheet (contract 1.1), when Go has one for it. */
/** photos: the Server team's 10 Oct B3, Go's re-hosted copies, labelled when the source says what each shows (photos.ts). */
export interface CardPick { optionId: string; option: ResultOption; imageUrl: string | null; details?: OptionDetailsT; photos?: C.Photo[] }

/** A stay as its whole price is said: its total, and the nights, rooms and head count ixigo priced it for. */
type StayPrice = { totalMinor?: number; facts?: ResultOption['facts'] };

/** What a stay's whole price covers, in words: "3 nights", "3 nights, 2 rooms"; null when its nights are not known. */
function stayCovers(o: StayPrice): string | null {
  const nights = typeof o.facts?.nights === 'number' && o.facts.nights > 0 ? o.facts.nights : null;
  const rooms = typeof o.facts?.rooms === 'number' && o.facts.rooms > 1 ? o.facts.rooms : null;
  return nights ? `${nights} night${nights === 1 ? '' : 's'}${rooms ? `, ${rooms} rooms` : ''}` : null;
}

/** What a stay's whole price covers, as its price says it: "for 3 nights", "for 3 nights, 2 rooms", or the whole stay. */
function stayNote(o: StayPrice): string {
  const covers = stayCovers(o);
  return covers ? `for ${covers}` : 'for the whole stay';
}

/** A stay's night as its whole price's brackets say it: "₹12,800 a night", "₹11,972 a room a night" for more rooms. */
function stayNight(o: Pick<ResultOption, 'priceMinor' | 'facts'>): string | null {
  const rooms = typeof o.facts.rooms === 'number' && o.facts.rooms > 1;
  return o.priceMinor !== undefined ? `${formatInr(o.priceMinor)} ${rooms ? 'a room a night' : 'a night'}` : null;
}

/**
 * Each person's share of a stay's whole price to the nearest ₹100, worked out here and never by the model ("about ₹7,700
 * each": the demo's ask was "under 8k a head"). Only with the nights and the head count ixigo priced it for, more than one.
 */
function shareWords(o: StayPrice): string | null {
  const nights = typeof o.facts?.nights === 'number' ? o.facts.nights : null;
  const guests = typeof o.facts?.guests === 'number' && o.facts.guests > 1 ? o.facts.guests : null;
  return o.totalMinor !== undefined && nights && guests ? `about ${formatInr(Math.round(o.totalMinor / guests / 10_000) * 10_000)} each` : null;
}

/**
 * Stays' "from": the cheapest whole stay, what that covers and each person's share ("from ₹11,178 for 3 nights, 2 rooms,
 * about ₹2,200 each"), never a night's (the exam, 10 Oct: "from ₹621 per night, per room" for five people); nothing when
 * none has a total. A stays card's fallback and the line Go posts with it (answer.ts answerLine) both say it.
 */
export function stayFrom(stays: ReadonlyArray<StayPrice>): string {
  const cheapest = stays.filter((o) => o.totalMinor !== undefined).sort((a, b) => (a.totalMinor ?? 0) - (b.totalMinor ?? 0))[0];
  const total = cheapest?.totalMinor;
  if (!cheapest || total === undefined) return '';
  const each = shareWords(cheapest);
  return `, from ${formatInr(total)} ${stayNote(cheapest)}${each ? `, ${each}` : ''}`;
}

/**
 * A stay as its vote and its payment say it: the whole stay first with what it covers, the night only in brackets
 * ("Anjuna, ₹38,400 for 3 nights (₹12,800 a night), about ₹7,700 each"), so the pay card's "Paid ₹38,400 for Villa Sol,
 * …" never reads as a night's (the lead, 10 Oct). A stay with no total says what its card does.
 */
export function stayLine(o: ResultOption): string | null {
  if (o.totalMinor === undefined) return subtitleFor(o);
  const area = typeof o.facts.area === 'string' ? o.facts.area : null;
  const night = stayNight(o);
  return [area, `${formatInr(o.totalMinor)} ${stayNote(o)}${night ? ` (${night})` : ''}`, shareWords(o)].filter((x): x is string => x !== null).join(', ');
}

/**
 * A stay as its payment names it beside the amount, which the pay card says already: what the whole stay covers and its
 * night in brackets ("Anjuna: 3 nights (₹12,800 a night)"), so "Paid ₹38,400 to ixigo for Villa Sol, Anjuna: 3 nights
 * (₹12,800 a night)" never says the amount twice (the lead, 10 Oct). Null when there is nothing to say.
 */
export function stayPayWords(o: ResultOption): string | null {
  const covers = stayCovers(o);
  const night = stayNight(o);
  const what = covers && night ? `${covers} (${night})` : (covers ?? night);
  if (!what) return null;
  return typeof o.facts.area === 'string' ? `${o.facts.area}: ${what}` : what;
}

function cardOption(p: CardPick): CardOption {
  const o = p.option;
  const subtitle = subtitleFor(o);
  // A stay's price is the whole stay, as on its vote and its payment, or none when Go has no total for it: never a night's
  // (the Server team's 10 Oct §6c saw ₹11,800 on a card and ₹35,400 on the vote built from it). The night is in the subtitle.
  const stay = o.kind === 'stay';
  const price = stay ? o.totalMinor : o.priceMinor;
  const note = stay ? (price !== undefined ? stayNote(o) : undefined) : o.priceNote;
  return {
    option_id: p.optionId,
    title: clip(o.title, 80),
    ...(subtitle ? { subtitle: clip(subtitle, 120) } : {}),
    ...(p.imageUrl ? { image_url: p.imageUrl } : {}),
    ...(price !== undefined ? { price_minor: price, currency: o.currency ?? 'INR' } : {}),
    ...(note ? { price_note: clip(note, 40) } : {}),
    highlights: o.highlights.map((h) => clip(h, 40)).filter((h) => h.length > 0).slice(0, 4),
    ...(o.journey ? { journey: o.journey } : {}),
    ...(o.place ? { place: { ...o.place, name: clip(o.place.name, 120), ...(o.place.address ? { address: clip(o.place.address, 200) } : {}) } } : {}),
    ...(o.rating !== undefined ? { rating: Math.min(5, Math.max(0, o.rating)) } : {}),
    ...(o.refundableUntil ? { refundable_until: o.refundableUntil } : {}),
    ...(p.details ? { details: p.details } : {}),
    ...(p.photos?.length ? { photos: p.photos } : {}),
  };
}

const KIND_WORDS: Record<OptionKind, [string, string]> = {
  stay: ['stay', 'stays'], flight: ['flight', 'flights'], train: ['train', 'trains'], bus: ['bus', 'buses'],
  place: ['place', 'places'], food: ['place to eat', 'places to eat'], activity: ['thing to do', 'things to do'],
  cab: ['cab', 'cabs'],
};

/** The options card, checked against the contract: a bug here throws instead of posting a card the App cannot draw. */
/**
 * seeAll: the card's last button opens the whole list on ixigo.com instead of each option's page (stays, three shown).
 * forPersonIds: a card for those people alone (each person's own flights, flights-each.ts): the room sees it, and only
 * they act on it, each tap their own.
 */
export function buildOptionsCard(i: {
  cardId: string; title: string; optionKind: OptionKind; checkedAt: string; picks: CardPick[]; seeAll?: boolean; forPersonIds?: string[];
}): OptionsCardT {
  const priced = i.picks.filter((p) => p.option.priceMinor !== undefined);
  const cheapest = [...priced].sort((a, b) => (a.option.priceMinor ?? 0) - (b.option.priceMinor ?? 0))[0];
  const from = cheapest ? `, from ${formatInr(cheapest.option.priceMinor ?? 0)}${cheapest.option.priceNote ? ` ${cheapest.option.priceNote}` : ''}` : '';
  const [one, many] = KIND_WORDS[i.optionKind];
  return C.OptionsCard.parse({
    card_id: i.cardId,
    kind: 'options',
    // A stays card's from is its whole stay and each share; a night's only when none of its stays has a total.
    fallback_text: clip(`${i.picks.length} ${i.picks.length === 1 ? one : many}: ${i.title}${(i.optionKind === 'stay' ? stayFrom(i.picks.map((p) => p.option)) : '') || from}`, 300),
    title: clip(i.title, 80),
    option_kind: i.optionKind,
    checked_at: i.checkedAt,
    options: i.picks.map(cardOption),
    actions: i.forPersonIds ? optionsActions(i).map((a) => ({ ...a, only_for_person_ids: i.forPersonIds })) : optionsActions(i),
    ...(i.forPersonIds ? { for_person_ids: i.forPersonIds } : {}),
  });
}

function optionsActions(i: { optionKind: OptionKind; picks: CardPick[]; seeAll?: boolean }) {
  // A ticket is its traveller's own: picked, never voted (PERSONAL_KINDS).
  const group = [PICK_ACTION, ...(i.picks.length >= 2 && !PERSONAL_KINDS.has(i.optionKind) ? [VOTE_ACTION] : [])];
  const open = i.picks.some((p) => ixigoPage(p.option.sourceUrl)) ? [OPEN_ACTION] : [];
  return [...group, ...(i.seeAll ? [SEE_ALL_ACTION] : open)];
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

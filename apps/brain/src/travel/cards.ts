/**
 * The options card and the small words on it: prices in rupees the Indian way, clocks as people say them, and no
 * em or en dashes in anything a person sees (master §7).
 */
import * as C from '@go/contract';
import type { z } from 'zod';
import type { OptionKind, ResultOption } from './results.js';

export type OptionsCardT = z.infer<typeof C.OptionsCard>;
type CardOption = OptionsCardT['options'][number];

export const PICK_ACTION = { action_id: 'pick', label: "I'll take this", style: 'primary', per_option: true } as const;
export const VOTE_ACTION = { action_id: 'vote', label: 'Put it to a vote', style: 'secondary' } as const;

export function plain(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
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

export function formatClock(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${hhmm.slice(3, 5)} ${h < 12 ? 'am' : 'pm'}`;
}

const CLASS_WORDS: Record<string, string> = { '1A': 'AC First Class', '2A': 'AC 2 Tier', '3A': 'AC 3 Tier', SL: 'Sleeper', CC: 'AC Chair Car', '2S': 'Second Sitting' };

export function subtitleFor(o: ResultOption): string | null {
  if (o.subtitle) return o.subtitle;
  if (o.journey) {
    const j = o.journey;
    const nextDay = j.arrive_at.slice(0, 10) !== j.depart_at.slice(0, 10) ? ' next day' : '';
    let extra: string | null = null;
    if (o.kind === 'flight' && typeof j.stops === 'number') extra = j.stops === 0 ? 'non-stop' : `${j.stops} stop`;
    if (o.kind === 'train' && typeof o.facts.class_code === 'string') extra = CLASS_WORDS[o.facts.class_code] ?? o.facts.class_code;
    if (o.kind === 'bus' && typeof o.facts.bus_type === 'string') extra = o.facts.bus_type;
    return `${formatClock(localClock(j.depart_at))} to ${formatClock(localClock(j.arrive_at))}${nextDay}${extra ? `, ${extra}` : ''}`;
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
};

/** The options card, checked against the contract: a bug here throws instead of posting a card the App cannot draw. */
export function buildOptionsCard(i: { cardId: string; title: string; optionKind: OptionKind; checkedAt: string; picks: CardPick[] }): OptionsCardT {
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
    actions: i.picks.length >= 2 ? [PICK_ACTION, VOTE_ACTION] : [PICK_ACTION],
  });
}

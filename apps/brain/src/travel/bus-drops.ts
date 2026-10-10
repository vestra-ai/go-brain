/**
 * A bus's own drops on its card (the lead, 10 Oct): ixigo's list gives a bus one arrival, its first stop's, while its seat
 * layout gives each drop its own time (buses.stops' drop_times). Once the buses card's top pick's layout is read
 * (register.ts showPick), that option's line says its drops instead ("8:00 pm, drops Cuncolim 7:50 am to Mapusa 10:30 am
 * next day, VE AC Seater/Sleeper"), so the card and the answer never disagree. Only that line changes, in place.
 */
import type { ServerLink } from '../door/server-link.js';
import type { EngineAnswer } from './book/engine.js';
import { arrivalWords, busTimes, clip, formatClock, localClock } from './cards.js';
import { POSTED_WAIT_MS, type TopPick } from './pick-photos.js';
import type { ResultsStore } from './results.js';

/** A layout's drops as the read gives them, the earliest first: a short name and its time, "HH:MM". */
function dropsOf(row: Record<string, unknown> | undefined): Array<{ name: string; at: string }> {
  const list: unknown[] = Array.isArray(row?.['drop_times']) ? (row['drop_times'] as unknown[]) : [];
  return list.flatMap((entry) => {
    const { name, at } = (entry ?? {}) as Record<string, unknown>;
    return typeof name === 'string' && name.trim() !== '' && typeof at === 'string' && /^\d{2}:\d{2}$/.test(at) ? [{ name: name.trim(), at }] : [];
  });
}

/** True once the top pick's line says its drops and the card is replaced; a layout with no drop times, or a card or option no longer kept, changes nothing. */
export async function showBusDrops(
  d: {
    results: Pick<ResultsStore, 'card' | 'setOptionFields'>;
    link: Pick<ServerLink, 'request'>;
    /** brain.cardPosted: true once the card's post answered, waiting at most withinMs. */
    posted?: (tripId: string, cardId: string, withinMs: number) => Promise<boolean>;
  },
  tripId: string,
  pick: Pick<TopPick, 'cardId' | 'optionId'>,
  answer: EngineAnswer,
): Promise<boolean> {
  const drops = dropsOf(answer.as === 'facts' ? answer.rows[0] : undefined);
  if (drops.length === 0) return false;
  const kept = await d.results.card(tripId, pick.cardId);
  const option = kept?.card.options.find((o) => o.option_id === pick.optionId);
  const j = option?.journey;
  if (!option || !j) return false;
  const first = drops[0]!;
  const last = drops[drops.length - 1]!;
  const span = drops.length === 1 ? `drops ${first.name} ${formatClock(first.at)}` : `drops ${first.name} ${formatClock(first.at)} to ${last.name} ${formatClock(last.at)}`;
  // What the line said after its times (the bus's type) stays: after busTimes, or, on a card from before it, after the first comma.
  const times = busTimes(j);
  const rest = option.subtitle?.startsWith(times) ? option.subtitle.slice(times.length) : option.subtitle?.includes(', ') ? option.subtitle.slice(option.subtitle.indexOf(', ')) : '';
  const subtitle = clip(`${formatClock(localClock(j.depart_at))}, ${span}${arrivalWords(j.depart_at, j.arrive_at)}${rest}`, 120);
  const card = await d.results.setOptionFields(tripId, pick.cardId, pick.optionId, { subtitle });
  if (!card) return false;
  if (d.posted && !(await d.posted(tripId, pick.cardId, POSTED_WAIT_MS))) return false;
  await d.link.request('replace_card', { trip_id: tripId, card });
  return true;
}

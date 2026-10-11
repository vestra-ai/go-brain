/**
 * Dates agreed on a trip with a place mean stays shown (lead, 8 Oct; Go's hello promises "Tell me the dates and I'll
 * start with a villa"). When the stays head start (warm.ts) loaded and kept the stays for the trip's changed dates or
 * place, Go puts them up: the same search through the travel layer joins the kept one, so no page loads, and handOver
 * wakes Go with its options, which go up as one card and its line with no model call (search-wake.ts). Never as Go's
 * second message in a row: when Go has the last word (it set the dates in reply to an ask, or spoke and nobody answered)
 * or Go put options up since the change, the stays wait for an ask.
 */
import type { Desk } from '../desk/desk.js';
import type { Log } from '../log.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { ResultsStore } from './results.js';
import { handOver } from './tools.js';
import type { Travel, TravelQuery } from './travel.js';
import { HEAD_START_SETTLE_MS, type HeadStartAsk } from './warm.js';

export interface HeadStartWakeDeps {
  travel: () => Travel | undefined;
  packs: Pick<Packs, 'get'>;
  desk: Pick<Desk, 'put'>;
  results: Pick<ResultsStore, 'save'>;
  now: () => Date;
  log: Pick<Log, 'info' | 'warn'>;
}

/**
 * The room is past the head start: Go has the last word, or a card of options from Go went up at or after `sinceMs`.
 */
export function roomPastHeadStart(pack: TripPack, sinceMs: number): boolean {
  const room = pack.messages.filter((m) => !m.deleted).sort((a, b) => a.seq - b.seq);
  if (room.at(-1)?.author.kind === 'go') return true;
  return room.some((m) => m.author.kind === 'go' && m.card?.kind === 'options' && Date.parse(m.sent_at) >= sinceMs);
}

/** The head start's onChangedKept: puts the kept stays up for the trip's agreed dates, or nothing. Never throws. */
export function showHeadStartStays(d: HeadStartWakeDeps): (tripId: string, ask: HeadStartAsk, startedAt: Date) => void {
  return (tripId, ask, startedAt) => {
    const show = async (): Promise<void> => {
      const travel = d.travel();
      if (!travel) return;
      // The change came at least the settle before the head start began.
      if (roomPastHeadStart(await d.packs.get(tripId), startedAt.getTime() - HEAD_START_SETTLE_MS)) {
        d.log.info({ tripId }, "travel: the head start's stays wait for an ask: Go has the last word, or put options up since");
        return;
      }
      const q: TravelQuery = { to: ask.place, checkIn: ask.check_in, checkOut: ask.check_out };
      handOver('stays', q, travel.search('stays', q, { tripId }), { tripId, fallbackId: `head_start:${ask.check_in}:${ask.check_out}` }, d);
    };
    show().catch((err: unknown) => d.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: the head start's stays could not be put up"));
  };
}

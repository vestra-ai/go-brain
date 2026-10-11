/**
 * "Choose this" on a card in a trip of one (Keshav, 12 Oct: "a trip of one never gets a vote; their word is the
 * decision"; prod t_12c5fbab40c74f41, 11 Oct: four stays votes for one person). Their tap is the trip's choice, at once:
 * a stay is saved as the stay and booked for them (booking/stay-for-one.ts); a place is saved as the trip's place, its
 * title following (places-card.ts retitled), and Go takes the next step in the room; anything else is theirs, and Go
 * replies in the room. The tap answers at once; the writes run behind it.
 */
import type { Desk } from '../desk/desk.js';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { Log } from '../log.js';
import type { Packs } from '../trips/pack.js';
import { saveTrip, type SaveTripDeps } from '../trips/save-trip.js';
import type { StayForOne } from './booking/stay-for-one.js';
import { clip } from './cards.js';
import { stableId } from './ids.js';
import { retitled } from './places-card.js';
import type { ResultsStore } from './results.js';

export interface ChooseDeps {
  results: Pick<ResultsStore, 'offer' | 'card'>;
  packs: Pick<Packs, 'get'>;
  link: Pick<ServerLink, 'request'>;
  desk: Pick<Desk, 'put'>;
  save: SaveTripDeps;
  stays: Pick<StayForOne, 'start'>;
  now: () => Date;
  log: Log;
}

export function chooseTap(d: ChooseDeps) {
  return async (tap: CardTapParams): Promise<CardTapResult> => {
    const offer = tap.option_id ? await d.results.offer(tap.option_id) : null;
    if (!offer || offer.cardId !== tap.card_id || offer.tripId !== tap.trip_id) return { result: 'refused', toast: 'That option is no longer available' };
    const row = await d.results.card(tap.trip_id, tap.card_id);
    if (!row || !(row.card.for_person_ids ?? []).includes(tap.person_id)) return { result: 'refused', toast: 'This one is for someone else to choose' };
    const pack = await d.packs.get(tap.trip_id);
    const at = { link: d.link, tripId: tap.trip_id, pack, requestId: () => stableId('go_choose', tap.tap_id) };
    const failed = (what: string) => (err: unknown) => {
      d.log.warn({ err: String(err).slice(0, 200), cardId: tap.card_id }, `travel: a chosen ${what} was not saved`);
      return null;
    };
    if (offer.kind === 'stay') {
      void saveTrip(d.save, at, { stay: offer.title, agreed: true }).catch(failed('stay'));
      const name = pack.trip.people.find((p) => p.person_id === tap.person_id)?.name ?? 'you';
      const started = d.stays.start({ tapId: tap.tap_id, tripId: tap.trip_id, personId: tap.person_id, name, offer });
      return { result: 'done', toast: started === 'running' ? 'Go is already booking it' : `${clip(offer.title, 40)} it is. Go is booking it` };
    }
    const put = (saved: boolean | null) =>
      d.desk.put({
        id: `travel:chosen:${tap.tap_id}`, tripId: tap.trip_id, kind: 'tap', ref: tap.card_id, dueAt: d.now(),
        payload: { source: 'options', action: 'chosen', kind: offer.kind, cardId: tap.card_id, optionId: offer.optionId, title: offer.title, personId: tap.person_id, saved },
      });
    if (offer.kind === 'place') {
      // The trip's place, through its one writer (resolved to ixigo's place), then Go says it and takes the next step.
      void (async () => {
        const title = retitled(pack.trip.title, pack.trip.destination?.name ?? null, offer.title);
        const saved = await saveTrip(d.save, at, { destination: offer.title, ...(title ? { title } : {}), agreed: true }).catch(failed('place'));
        await put(saved?.ok === true);
      })().catch((err: unknown) => d.log.error({ err: String(err).slice(0, 200), cardId: tap.card_id }, 'travel: a chosen place went unsaid'));
      return { result: 'done', toast: `${clip(offer.title, 40)} it is` };
    }
    await put(null);
    return { result: 'done', toast: 'Noted. Go will reply in the room.' };
  };
}

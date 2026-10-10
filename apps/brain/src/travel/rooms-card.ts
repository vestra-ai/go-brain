/**
 * The rooms card (the Server's REV4 B5, 10 Oct): once a vote picks a stay, the ways the group can take its rooms, who
 * shares with whom, and what each person pays, so everyone sees their amount before anyone pays (the lead's call). It
 * rides on the turn that says the vote closed; when the stay's rooms take longer to read than that turn waits, it posts on
 * its own once they are read. A tap keeps the way picked, for the expense per room (B6, chosenArrangement), and the card
 * says it in place.
 */
import type * as C from '@go/contract';
import type pg from 'pg';
import type { Brain } from '../app.js';
import type { TurnCard } from '../composer/context.js';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { Log } from '../log.js';
import type { TripPack } from '../trips/pack.js';
import type { Engine } from './book/engine.js';
import { clip, ixigoPage } from './cards.js';
import { stableId } from './ids.js';
import type { ResultsStore } from './results.js';
import { arrangementsFor, roomTypesOf, type Arrangement } from './rooms.js';
import { stayOf } from './web-stays.js';

export const ROOMS_PICK = 'pick';
/** How long the vote's turn waits for the stay's rooms: the top pick's page, read by its stage click, is kept and answers at once. */
export const ROOMS_WAIT_MS = 4_000;

export interface RoomsCardRow {
  cardId: string;
  tripId: string;
  decisionId: string;
  optionRef: string;
  stay: string;
  arrangements: Arrangement[];
  chosenId: string | null;
  chosenBy: string | null;
}

export interface RoomsCards {
  save(row: Omit<RoomsCardRow, 'chosenId' | 'chosenBy'>): Promise<void>;
  get(cardId: string): Promise<RoomsCardRow | null>;
  choose(cardId: string, arrangementId: string, personId: string): Promise<void>;
  /** The way the group picked to take a stay's rooms (its vote option's option_ref), from its newest rooms card; null when none was picked. */
  chosenArrangement(tripId: string, optionRef: string): Promise<Arrangement | null>;
}

interface Db { card_id: string; trip_id: string; decision_id: string; option_ref: string; stay: string; arrangements: Arrangement[]; chosen_id: string | null; chosen_by: string | null }

const rowOf = (r: Db): RoomsCardRow => ({
  cardId: r.card_id, tripId: r.trip_id, decisionId: r.decision_id, optionRef: r.option_ref, stay: r.stay, arrangements: r.arrangements, chosenId: r.chosen_id, chosenBy: r.chosen_by,
});

export function createRoomsCards(pool: pg.Pool): RoomsCards {
  return {
    async save(row) {
      await pool.query(
        `insert into rooms_cards (card_id, trip_id, decision_id, option_ref, stay, arrangements) values ($1, $2, $3, $4, $5, $6)
         on conflict (card_id) do nothing`,
        [row.cardId, row.tripId, row.decisionId, row.optionRef, row.stay, JSON.stringify(row.arrangements)],
      );
    },
    async get(cardId) {
      const { rows } = await pool.query<Db>('select * from rooms_cards where card_id = $1', [cardId]);
      return rows[0] ? rowOf(rows[0]) : null;
    },
    async choose(cardId, arrangementId, personId) {
      await pool.query('update rooms_cards set chosen_id = $2, chosen_by = $3, chosen_at = now() where card_id = $1', [cardId, arrangementId, personId]);
    },
    async chosenArrangement(tripId, optionRef) {
      const { rows } = await pool.query<Db>(
        'select * from rooms_cards where trip_id = $1 and option_ref = $2 and chosen_id is not null order by created_at desc limit 1',
        [tripId, optionRef],
      );
      const r = rows[0];
      return r ? (r.arrangements.find((a) => a.arrangementId === r.chosen_id) ?? null) : null;
    },
  };
}

/** The card for a stay's ways to take its rooms; with a way picked, it says which and who picked it. */
export function roomsCard(o: {
  cardId: string;
  stay: string;
  optionRef: string;
  arrangements: Arrangement[];
  forPersonIds: string[];
  picked?: { label: string; by: string };
}): C.Card {
  const title = clip(o.picked ? `Rooms at ${o.stay}: ${o.picked.label}` : `Rooms at ${o.stay}`, 80);
  return {
    card_id: o.cardId,
    kind: 'rooms',
    fallback_text: clip(o.picked ? `${o.picked.by} picked ${o.picked.label} at ${o.stay}` : `Pick how you split the rooms at ${o.stay}`, 300),
    title,
    option_id: o.optionRef,
    for_person_ids: o.forPersonIds,
    arrangements: o.arrangements.map((a) => ({
      arrangement_id: a.arrangementId,
      label: clip(a.label, 80),
      rooms: a.rooms.map((r) => ({ room_type_id: r.roomTypeId, label: clip(r.label, 60), person_ids: r.personIds, price_minor: r.priceMinor })),
      total_minor: a.totalMinor,
      per_person: a.perPerson.map((p) => ({ person_id: p.personId, amount_minor: p.amountMinor })),
    })),
    actions: [{ action_id: ROOMS_PICK, label: o.picked ? 'Change' : 'Choose', style: 'primary', per_option: true }],
  };
}

export interface RoomsCardDeps {
  engine: Pick<Engine, 'answer'>;
  results: Pick<ResultsStore, 'offer'>;
  store: RoomsCards;
  link: Pick<Brain['door']['link'], 'request'>;
  packs: { get(tripId: string): Promise<TripPack> };
  log: Pick<Log, 'warn'>;
  waitMs?: number;
}

const LINE = (stay: string): string => `Here's how the rooms at ${stay} can split, and what each of you pays for the stay. Pick one.`;

/** On the turn Go wakes for a closed vote that picked a stay: its rooms card, or, when its rooms are still being read, none now and one on its own once they are. */
export function roomsCardOnClose(d: RoomsCardDeps): TurnCard {
  return async ({ tripId, wake, pack }) => {
    const closed = wake.find((w) => w.kind === 'trip_change' && (w.payload as { type?: string } | null)?.type === 'decision.closed');
    const decisionId = (closed?.payload as { decisionId?: string } | undefined)?.decisionId;
    const decision = decisionId ? pack.trip.decisions.find((x) => x.decision_id === decisionId) : undefined;
    if (!decision || decision.kind !== 'choice' || decision.result_index == null) return null;
    const won = decision.options[decision.result_index];
    if (!won?.option_ref) return null;
    const offer = await d.results.offer(won.option_ref);
    const page = offer?.kind === 'stay' ? ixigoPage(offer.sourceUrl) : null;
    const stay = page ? stayOf(page) : null;
    if (!offer || !page || !stay) return null;
    const people = pack.trip.people.map((p) => p.person_id);
    const cardId = stableId('c_rooms', tripId, decision.decision_id);
    const build = async (): Promise<{ card: C.Card; line: string } | null> => {
      const read = await d.engine.answer('hotels.details', { hotel: page }, { tripId });
      const row = read.as === 'facts' ? read.rows[0] : undefined;
      const arrangements = row ? arrangementsFor(roomTypesOf(row, stay.nights), people) : [];
      if (arrangements.length === 0) return null;
      await d.store.save({ cardId, tripId, decisionId: decision.decision_id, optionRef: won.option_ref!, stay: offer.title, arrangements });
      return {
        card: roomsCard({ cardId, stay: offer.title, optionRef: won.option_ref!, arrangements, forPersonIds: [pack.trip.organizer_person_id] }),
        line: LINE(offer.title),
      };
    };
    const built = build();
    const soon = await Promise.race([
      built.catch((err: unknown) => {
        d.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: a picked stay's rooms didn't read; no rooms card");
        return null;
      }),
      new Promise<'later'>((resolve) => setTimeout(() => resolve('later'), d.waitMs ?? ROOMS_WAIT_MS).unref()),
    ]);
    if (soon !== 'later') return soon;
    // Still reading: the card posts on its own when the rooms are in.
    void built
      .then(async (r) => {
        if (r) await d.link.request('post_message', { request_id: stableId('go_rooms', tripId, decision.decision_id), trip_id: tripId, text: r.line, card: r.card });
      })
      .catch((err: unknown) => d.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: a picked stay's rooms card didn't post"));
    return null;
  };
}

/** A tap on a way to take the rooms: kept as the group's, and the card says it in place. */
export function roomsTap(d: Pick<RoomsCardDeps, 'store' | 'link' | 'packs' | 'log'>) {
  return async (tap: CardTapParams): Promise<CardTapResult> => {
    const row = await d.store.get(tap.card_id);
    if (!row || row.tripId !== tap.trip_id) return { result: 'refused', toast: 'That card is not active any more.' };
    const picked = row.arrangements.find((a) => a.arrangementId === tap.option_id);
    if (!picked) return { result: 'refused', toast: 'That way is not on the card any more.' };
    await d.store.choose(row.cardId, picked.arrangementId, tap.person_id);
    const pack = await d.packs.get(tap.trip_id);
    const by = pack.trip.people.find((p) => p.person_id === tap.person_id)?.name ?? 'Someone';
    // The tap answers now; the card says the pick in place behind it.
    void d.link
      .request('replace_card', {
        trip_id: tap.trip_id,
        card: roomsCard({ cardId: row.cardId, stay: row.stay, optionRef: row.optionRef, arrangements: row.arrangements, forPersonIds: [pack.trip.organizer_person_id], picked: { label: picked.label, by } }),
      })
      .catch((err: unknown) => d.log.warn({ tripId: tap.trip_id, err: String(err).slice(0, 200) }, "travel: the rooms card didn't update"));
    return { result: 'done', toast: clip(`${picked.label}: saved`, 120) };
  };
}

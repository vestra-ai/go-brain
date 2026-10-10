/**
 * The rooms card (the Server's REV4 B5, 10 Oct): once a vote picks a stay, the ways the group can take its rooms, who
 * shares with whom, and what each person pays, so everyone sees their amount before anyone pays (the lead's call). It
 * rides on the turn that says the vote closed; when the stay's rooms take longer to read than that turn waits, it posts on
 * its own once they are read. A tap keeps the way picked, for the expense per room (B6, chosenArrangement), and the card
 * says it in place. The card closes when the stay's payment starts (closeRooms, the lead's ruling): the way picked then
 * holds, a later tap is refused, and the card shows it with no button; with none picked, the stay is one expense.
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
  closed: boolean;
}

export interface RoomsCards {
  save(row: Omit<RoomsCardRow, 'chosenId' | 'chosenBy' | 'closed'>): Promise<void>;
  get(cardId: string): Promise<RoomsCardRow | null>;
  /** The stay's newest rooms card (its vote option's option_ref); null when it has none. */
  latest(tripId: string, optionRef: string): Promise<RoomsCardRow | null>;
  /** False when the card is closed: the way picked holds. */
  choose(cardId: string, arrangementId: string, personId: string): Promise<boolean>;
  /** True when this call closed it; false when it was closed already. */
  close(cardId: string): Promise<boolean>;
  /** The way the group picked to take a stay's rooms (its vote option's option_ref), from its newest rooms card; null when none was picked. */
  chosenArrangement(tripId: string, optionRef: string): Promise<Arrangement | null>;
}

interface Db {
  card_id: string; trip_id: string; decision_id: string; option_ref: string; stay: string; arrangements: Arrangement[]; chosen_id: string | null; chosen_by: string | null;
  closed_at: Date | null;
}

const rowOf = (r: Db): RoomsCardRow => ({
  cardId: r.card_id, tripId: r.trip_id, decisionId: r.decision_id, optionRef: r.option_ref, stay: r.stay, arrangements: r.arrangements, chosenId: r.chosen_id, chosenBy: r.chosen_by,
  closed: r.closed_at !== null,
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
    async latest(tripId, optionRef) {
      const { rows } = await pool.query<Db>('select * from rooms_cards where trip_id = $1 and option_ref = $2 order by created_at desc limit 1', [tripId, optionRef]);
      return rows[0] ? rowOf(rows[0]) : null;
    },
    async choose(cardId, arrangementId, personId) {
      const r = await pool.query('update rooms_cards set chosen_id = $2, chosen_by = $3, chosen_at = now() where card_id = $1 and closed_at is null', [cardId, arrangementId, personId]);
      return (r.rowCount ?? 0) > 0;
    },
    async close(cardId) {
      const r = await pool.query('update rooms_cards set closed_at = now() where card_id = $1 and closed_at is null', [cardId]);
      return (r.rowCount ?? 0) > 0;
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

/**
 * The card for a stay's ways to take its rooms; with a way picked, it says which and who picked it. closed: the stay's
 * payment started, so the card is final, with no button (none picked: the stay is one expense, split evenly).
 */
export function roomsCard(o: {
  cardId: string;
  stay: string;
  optionRef: string;
  arrangements: Arrangement[];
  forPersonIds: string[];
  picked?: { label: string; by: string };
  closed?: boolean;
}): C.Card {
  const title = clip(o.picked ? `Rooms at ${o.stay}: ${o.picked.label}` : o.closed ? `Rooms at ${o.stay}: split evenly` : `Rooms at ${o.stay}`, 80);
  const said = o.picked
    ? `${o.picked.by} picked ${o.picked.label} at ${o.stay}`
    : o.closed ? `No split picked at ${o.stay}: the stay is split evenly` : `Pick how you split the rooms at ${o.stay}`;
  return {
    card_id: o.cardId,
    kind: 'rooms',
    fallback_text: clip(said, 300),
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
    actions: o.closed ? [] : [{ action_id: ROOMS_PICK, label: o.picked ? 'Change' : 'Choose', style: 'primary', per_option: true }],
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
    if (row.closed) return { result: 'refused', toast: ROOMS_SET };
    const picked = row.arrangements.find((a) => a.arrangementId === tap.option_id);
    if (!picked) return { result: 'refused', toast: 'That way is not on the card any more.' };
    // The payment may have closed the card since it was read: the way picked then holds.
    if (!(await d.store.choose(row.cardId, picked.arrangementId, tap.person_id))) return { result: 'refused', toast: ROOMS_SET };
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

export const ROOMS_SET = 'Rooms are set: the stay is paid.';

/**
 * The stay's payment started (the lead's ruling, 10 Oct): its rooms card closes, the way picked holds for the expense per
 * room (B6) however often the finish runs, and the card shows it with no button. Gives the way picked, or null when none
 * was (the stay is then one expense, split evenly) or the stay has no rooms card. Closing again gives the same, with no
 * second update of the card.
 */
export async function closeRooms(d: Pick<RoomsCardDeps, 'store' | 'link' | 'packs' | 'log'>, tripId: string, optionRef: string): Promise<Arrangement | null> {
  const row = await d.store.latest(tripId, optionRef);
  if (!row) return null;
  const chosen = row.chosenId ? (row.arrangements.find((a) => a.arrangementId === row.chosenId) ?? null) : null;
  if (!(await d.store.close(row.cardId))) {
    // Closed already: what it held when it closed (a tap since was refused).
    const now = await d.store.get(row.cardId);
    return now?.chosenId ? (now.arrangements.find((a) => a.arrangementId === now.chosenId) ?? null) : null;
  }
  // A tap that landed between the read and the close was kept: read the card as it closed.
  const closed = (await d.store.get(row.cardId)) ?? row;
  const held = closed.chosenId ? (closed.arrangements.find((a) => a.arrangementId === closed.chosenId) ?? null) : chosen;
  const pack = await d.packs.get(tripId);
  const by = held && closed.chosenBy ? (pack.trip.people.find((p) => p.person_id === closed.chosenBy)?.name ?? 'Someone') : null;
  await d.link
    .request('replace_card', {
      trip_id: tripId,
      card: roomsCard({
        cardId: row.cardId, stay: row.stay, optionRef: row.optionRef, arrangements: row.arrangements, forPersonIds: [pack.trip.organizer_person_id],
        ...(held && by ? { picked: { label: held.label, by } } : {}),
        closed: true,
      }),
    })
    .catch((err: unknown) => d.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: the closed rooms card didn't update"));
  return held;
}

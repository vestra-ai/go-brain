import type * as C from '@go/contract';
import type pg from 'pg';
import type { ToServerMethod } from './methods.js';

/** Go's room cards, so a tap can be routed by the card's kind. Never payment card details. */
export interface CardStore {
  record(tripId: string, card: C.Card, messageId: string | null): Promise<void>;
  get(tripId: string, cardId: string): Promise<C.Card | null>;
  /** ServerLink's onResult: keeps every card Go posts or replaces. */
  observe(method: ToServerMethod, params: Record<string, unknown>, result: unknown): Promise<void>;
}

export function createCardStore(o: { pool: pg.Pool; now: () => Date }): CardStore {
  async function record(tripId: string, card: C.Card, messageId: string | null): Promise<void> {
    await o.pool.query(
      `insert into cards (trip_id, card_id, kind, message_id, card, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (trip_id, card_id) do update
         set card = excluded.card, message_id = coalesce(excluded.message_id, cards.message_id), updated_at = excluded.updated_at`,
      [tripId, card.card_id, card.kind, messageId, JSON.stringify(card), o.now()],
    );
  }
  return {
    record,
    async get(tripId, cardId) {
      const { rows } = await o.pool.query<{ card: C.Card }>('select card from cards where trip_id = $1 and card_id = $2', [tripId, cardId]);
      return rows[0]?.card ?? null;
    },
    async observe(method, params, result) {
      if (method !== 'post_message' && method !== 'replace_card') return;
      const card = params.card as C.Card | null | undefined;
      const tripId = params.trip_id;
      if (!card || typeof tripId !== 'string') return;
      const messageId = (result as { message_id?: unknown } | null)?.message_id;
      await record(tripId, card, typeof messageId === 'string' ? messageId : null);
    },
  };
}

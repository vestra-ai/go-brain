import type * as C from '@go/contract';
import type pg from 'pg';
import type { ToServerMethod } from './methods.js';

/**
 * Go's room cards, so a tap can be routed by the card's kind. Never payment card details. A card is kept the moment Go
 * sends it (pending), because the room can show it, and a person tap it, before the Server's answer reaches Go.
 */
export interface CardStore {
  record(tripId: string, card: C.Card, messageId: string | null): Promise<void>;
  get(tripId: string, cardId: string): Promise<C.Card | null>;
  /** ServerLink's onSend: a card Go is posting is kept before the request goes out, pending until the Server answers. */
  sending(method: ToServerMethod, params: Record<string, unknown>): Promise<void>;
  /**
   * ServerLink's onResult: keeps every card Go posts or replaces, live. For an answer a rerun got back from storage
   * (`stored`) it only marks a posted card landed: the card may have been replaced since, and is never written back.
   */
  observe(method: ToServerMethod, params: Record<string, unknown>, result: unknown, stored?: boolean): Promise<void>;
  /** ServerLink's onFail: a post that failed for sure takes its card away, unless a tap already proved the card landed. */
  failed(method: ToServerMethod, params: Record<string, unknown>): Promise<void>;
  /**
   * A tap from the Server proves the card landed: the card, made live in the same statement, or null when Go has no
   * such card. One statement, so a tap and a failed post's delete never both win.
   */
  landed(tripId: string, cardId: string): Promise<C.Card | null>;
}

/** The trip and card of a post_message that carries a card; null for anything else. */
function postedCard(method: ToServerMethod, params: Record<string, unknown>): { tripId: string; card: C.Card } | null {
  if (method !== 'post_message') return null;
  const card = params.card as C.Card | null | undefined;
  const tripId = params.trip_id;
  return card && typeof tripId === 'string' ? { tripId, card } : null;
}

export function createCardStore(o: { pool: pg.Pool; now: () => Date }): CardStore {
  async function record(tripId: string, card: C.Card, messageId: string | null): Promise<void> {
    await o.pool.query(
      `insert into cards (trip_id, card_id, kind, message_id, card, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (trip_id, card_id) do update
         set card = excluded.card, message_id = coalesce(excluded.message_id, cards.message_id), updated_at = excluded.updated_at,
             pending = false`,
      [tripId, card.card_id, card.kind, messageId, JSON.stringify(card), o.now()],
    );
  }
  return {
    record,
    async get(tripId, cardId) {
      const { rows } = await o.pool.query<{ card: C.Card }>('select card from cards where trip_id = $1 and card_id = $2', [tripId, cardId]);
      return rows[0]?.card ?? null;
    },
    async sending(method, params) {
      const posted = postedCard(method, params);
      if (!posted) return;
      // A resend (a reconnect, a crash rerun, a restart) finds the row already there, pending or live, and leaves it.
      await o.pool.query(
        `insert into cards (trip_id, card_id, kind, message_id, card, updated_at, pending) values ($1, $2, $3, null, $4::jsonb, $5, true)
         on conflict (trip_id, card_id) do nothing`,
        [posted.tripId, posted.card.card_id, posted.card.kind, JSON.stringify(posted.card), o.now()],
      );
    },
    async observe(method, params, result, stored = false) {
      if (method !== 'post_message' && method !== 'replace_card') return;
      const card = params.card as C.Card | null | undefined;
      const tripId = params.trip_id;
      if (!card || typeof tripId !== 'string') return;
      const messageId = (result as { message_id?: unknown } | null)?.message_id;
      if (stored) {
        if (method !== 'post_message') return;
        await o.pool.query(
          'update cards set pending = false, message_id = coalesce(message_id, $3) where trip_id = $1 and card_id = $2 and pending',
          [tripId, card.card_id, typeof messageId === 'string' ? messageId : null],
        );
        return;
      }
      await record(tripId, card, typeof messageId === 'string' ? messageId : null);
    },
    async failed(method, params) {
      const posted = postedCard(method, params);
      if (!posted) return;
      await o.pool.query('delete from cards where trip_id = $1 and card_id = $2 and pending', [posted.tripId, posted.card.card_id]);
    },
    async landed(tripId, cardId) {
      // The row lock orders this against failed()'s delete: whichever runs first wins, and the other sees its result.
      const { rows } = await o.pool.query<{ card: C.Card }>(
        'update cards set pending = false where trip_id = $1 and card_id = $2 returning card',
        [tripId, cardId],
      );
      return rows[0]?.card ?? null;
    },
  };
}

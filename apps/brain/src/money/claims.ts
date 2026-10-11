/**
 * Who books for the group (contract 1.1, A10). When a stay vote closes, one person pays for everyone now and books it;
 * the group settles up after. Go never picks that person: it puts up one card for everyone, "One person books for all",
 * with one button, "I'll book it", and the first to take it is the payer. Saying it in words is the same: someone who
 * asks Go to book it ("@Go book Saudades") takes it then, through the same first-wins claim. Go then sets the mandate
 * for them, and the card says "Rahul is booking for all 4", with no buttons; anyone later hears "Rahul is already
 * booking this." The payer's ixigo login gate and the parked booking (travel/web-stays.ts) apply to whoever claims.
 */
import type * as C from '@go/contract';
import type pg from 'pg';
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { clip, plain } from './words.js';

export const CLAIM_ACTION = 'claim';
const CLAIM_CARD = 'c_claim_';
export const claimCardId = (decisionId: string): string => `${CLAIM_CARD}${decisionId}`;
export const decisionOfClaimCard = (cardId: string): string | null => (cardId.startsWith(CLAIM_CARD) ? cardId.slice(CLAIM_CARD.length) : null);

export interface Claim {
  personId: string | null;
  /** The turn whose post carried the card, so a rerun of that turn carries it again; null when no card went up. */
  offeredTurn: string | null;
}

/**
 * The claim card: unclaimed, everyone sees the one button; claimed, it says who is booking, with no buttons. A trip of one
 * books for themselves: no "for all 1", nobody to split it with.
 */
export function claimCard(o: { decisionId: string; what: string; people: number; claimer: string | null }): C.Card {
  const what = clip(plain(o.what), 80);
  const alone = o.people === 1;
  if (o.claimer) {
    const title = clip(alone ? `${o.claimer} is booking ${what}` : `${o.claimer} is booking for all ${o.people}`, 80);
    return {
      card_id: claimCardId(o.decisionId),
      kind: 'notice',
      tone: 'info',
      title,
      body: clip(
        alone ? `${o.claimer} pays for ${what} and books it.` : `${o.claimer} pays for ${what} now and books it for everyone. Go splits it with the group after.`,
        500,
      ),
      actions: [],
      fallback_text: title,
    };
  }
  if (alone) {
    return {
      card_id: claimCardId(o.decisionId),
      kind: 'notice',
      tone: 'info',
      title: clip(`Book ${what}`, 80),
      body: clip(`Tap I'll book it when you're ready to pay for ${what} and book it.`, 500),
      actions: [{ action_id: CLAIM_ACTION, label: "I'll book it", style: 'primary' }],
      fallback_text: clip(`Book ${what}: tap I'll book it.`, 300),
    };
  }
  return {
    card_id: claimCardId(o.decisionId),
    kind: 'notice',
    tone: 'info',
    title: 'One person books for all',
    body: clip(`${what} won. Whoever taps I'll book it pays for everyone now and books it; Go splits it with the group after.`, 500),
    actions: [{ action_id: CLAIM_ACTION, label: "I'll book it", style: 'primary' }],
    fallback_text: clip(`One person books ${what} for all: tap I'll book it.`, 300),
  };
}

export function createClaims(pool: pg.Pool, now: () => Date) {
  async function get(tripId: string, decisionId: string): Promise<Claim | null> {
    const { rows } = await pool.query<{ person_id: string | null; offered_turn: string | null }>(
      'select person_id, offered_turn from booking_claims where trip_id = $1 and decision_id = $2',
      [tripId, decisionId],
    );
    const r = rows[0];
    return r ? { personId: r.person_id, offeredTurn: r.offered_turn } : null;
  }

  return {
    get,

    /**
     * The card goes up once per vote, on one turn's post: true when this turn put it up, or put it up before (a rerun
     * of the same turn). False when another turn did, or someone already claimed it.
     */
    async offer(tripId: string, decisionId: string, turnId: string): Promise<boolean> {
      await pool.query(
        `insert into booking_claims (trip_id, decision_id, offered_turn, offered_at) values ($1, $2, $3, $4)
         on conflict (trip_id, decision_id) do update set offered_turn = excluded.offered_turn, offered_at = excluded.offered_at
           where booking_claims.offered_turn is null and booking_claims.person_id is null`,
        [tripId, decisionId, turnId, now()],
      );
      const c = await get(tripId, decisionId);
      return c !== null && c.personId === null && c.offeredTurn === turnId;
    },

    /** The first claim wins: who holds it after this one (this person, or whoever was first). */
    async take(tripId: string, decisionId: string, personId: string): Promise<string> {
      const { rows } = await pool.query<{ person_id: string }>(
        `insert into booking_claims (trip_id, decision_id, person_id, claimed_at) values ($1, $2, $3, $4)
         on conflict (trip_id, decision_id) do update set person_id = excluded.person_id, claimed_at = excluded.claimed_at
           where booking_claims.person_id is null
         returning person_id`,
        [tripId, decisionId, personId, now()],
      );
      if (rows[0]) return rows[0].person_id;
      return (await get(tripId, decisionId))?.personId ?? personId;
    },
  };
}

export type Claims = ReturnType<typeof createClaims>;

/** The people whose own messages woke this turn: an ask to book it in their words is their claim. */
export function askersOf(wake: readonly DeskItem[], pack: Pick<TripPack, 'messages'>): string[] {
  const ids = new Set(wake.filter((i) => i.kind === 'message').map((i) => i.ref));
  const out = new Set<string>();
  for (const m of pack.messages) if (ids.has(m.message_id) && m.author.kind === 'person') out.add(m.author.person_id);
  return [...out];
}

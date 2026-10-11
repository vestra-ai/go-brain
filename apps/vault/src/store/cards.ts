import { randomBytes } from 'node:crypto';
import { itemAad, openJson, sealJson } from '../crypto/envelope.js';
import { DEMO_CARDS, type DemoCardId } from '../demo-cards.js';
import type { StripeLike } from '../stripe-client.js';
import { customerIdOf, ensurePerson, type Db } from './people.js';
import { logUnlock } from './unlock-log.js';

export interface CardSummary {
  card_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

/** The person's Stripe customer, made the first time they add a card. */
export async function customerFor(db: Db, stripe: StripeLike, personId: string, now: Date): Promise<string> {
  await ensurePerson(db, personId, now);
  const have = await customerIdOf(db, personId);
  if (have) return have;
  const created = await stripe.createCustomer(personId);
  const r = await db.query<{ stripe_customer_id: string }>(
    'update vault_people set stripe_customer_id = coalesce(stripe_customer_id, $2) where person_id = $1 returning stripe_customer_id',
    [personId, created.id],
  );
  return r.rows[0]?.stripe_customer_id ?? created.id;
}

/** Starts Stripe's card form for this person. The page gets only the client secret. */
export async function startCardSetup(db: Db, stripe: StripeLike, personId: string, now: Date): Promise<{ clientSecret: string }> {
  const customerId = await customerFor(db, stripe, personId, now);
  const si = await stripe.createSetupIntent(customerId);
  return { clientSecret: si.clientSecret };
}

export type SaveCardResult = { ok: true; card: CardSummary } | { ok: false; reason: 'not_finished' | 'not_yours' | 'no_card' };

/** Reads the SetupIntent from Stripe, never from the page, and keeps the sealed token plus what the page shows. */
export async function saveCardFromSetup(
  db: Db,
  stripe: StripeLike,
  master: Buffer,
  now: Date,
  o: { personId: string; setupIntentId: string },
): Promise<SaveCardResult> {
  let si: Awaited<ReturnType<StripeLike['readSetupIntent']>>;
  try {
    si = await stripe.readSetupIntent(o.setupIntentId);
  } catch {
    return { ok: false, reason: 'not_finished' };
  }
  if (si.status !== 'succeeded') return { ok: false, reason: 'not_finished' };
  const customerId = await customerIdOf(db, o.personId);
  if (!customerId || si.customerId !== customerId) return { ok: false, reason: 'not_yours' };
  if (!si.card || !/^[0-9]{4}$/.test(si.card.last4)) return { ok: false, reason: 'no_card' };
  const card: CardSummary = {
    card_id: `cd_${randomBytes(9).toString('base64url')}`,
    brand: si.card.brand,
    last4: si.card.last4,
    exp_month: si.card.expMonth,
    exp_year: si.card.expYear,
  };
  const sealed = sealJson(master, itemAad(o.personId, 'card', card.card_id), { pm: si.card.paymentMethodId });
  await db.query(
    'insert into cards (card_id, person_id, brand, last4, exp_month, exp_year, sealed, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [card.card_id, o.personId, card.brand, card.last4, card.exp_month, card.exp_year, sealed, now],
  );
  await logUnlock(db, now, { personId: o.personId, kind: 'card_added', cardId: card.card_id });
  return { ok: true, card };
}

/**
 * A demo test card (demo-cards.ts), named by the page, never typed to the vault: its brand, last four digits and expiry,
 * and its demo token sealed as a Stripe card's token is.
 */
export async function saveDemoCard(db: Db, master: Buffer, now: Date, o: { personId: string; card: DemoCardId; expMonth: number; expYear: number }): Promise<CardSummary> {
  await ensurePerson(db, o.personId, now);
  const demo = DEMO_CARDS[o.card];
  const card: CardSummary = { card_id: `cd_${randomBytes(9).toString('base64url')}`, brand: demo.brand, last4: demo.last4, exp_month: o.expMonth, exp_year: o.expYear };
  const sealed = sealJson(master, itemAad(o.personId, 'card', card.card_id), { pm: demo.ref });
  await db.query(
    'insert into cards (card_id, person_id, brand, last4, exp_month, exp_year, sealed, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [card.card_id, o.personId, card.brand, card.last4, card.exp_month, card.exp_year, sealed, now],
  );
  await logUnlock(db, now, { personId: o.personId, kind: 'card_added', cardId: card.card_id });
  return card;
}

export async function listCards(db: Db, personId: string): Promise<CardSummary[]> {
  const r = await db.query<CardSummary>(
    'select card_id, brand, last4, exp_month, exp_year from cards where person_id = $1 and removed_at is null order by created_at desc, card_id',
    [personId],
  );
  return r.rows;
}

/** The card a payment uses: the person's newest. */
export async function newestCard(db: Db, personId: string): Promise<CardSummary | null> {
  return (await listCards(db, personId))[0] ?? null;
}

/** Opens a card's processor token for one charge. The caller passes it straight to the rail and never logs it. */
export async function openCardRef(db: Db, master: Buffer, personId: string, cardId: string): Promise<string> {
  const r = await db.query<{ sealed: Buffer }>(
    'select sealed from cards where card_id = $1 and person_id = $2 and removed_at is null',
    [cardId, personId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('card not found');
  return openJson<{ pm: string }>(master, itemAad(personId, 'card', cardId), row.sealed).pm;
}

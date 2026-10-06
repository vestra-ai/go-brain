import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withVaultSchema } from '../db/test-db.js';
import { FakeStripe } from '../testing/fake-stripe.js';
import { listCards, newestCard, openCardRef, saveCardFromSetup, startCardSetup } from './cards.js';
import { ensurePerson } from './people.js';

const now = new Date('2026-10-05T08:50:00Z');
const master = randomBytes(32);
let pool: pg.Pool;
let schema: string;
let drop: () => Promise<void>;
const stripe = new FakeStripe();

/** What the page does: start a setup, Stripe's form finishes it, the page sends back only the SetupIntent id. */
async function addCard(personId: string) {
  const { clientSecret } = await startCardSetup(pool, stripe, personId, now);
  const setupIntentId = clientSecret.split('_secret_')[0] as string;
  stripe.completeSetup(setupIntentId);
  return { setupIntentId, saved: await saveCardFromSetup(pool, stripe, master, now, { personId, setupIntentId }) };
}

beforeAll(async () => {
  ({ pool, schema, drop } = await withVaultSchema());
  await ensurePerson(pool, 'p_rahul', now, 'Rahul');
  await ensurePerson(pool, 'p_priya', now, 'Priya');
});
afterAll(async () => {
  await drop();
});

describe('cards', () => {
  it('makes one Stripe customer per person', async () => {
    await startCardSetup(pool, stripe, 'p_rahul', now);
    await startCardSetup(pool, stripe, 'p_rahul', now);
    const r = await pool.query("select stripe_customer_id from vault_people where person_id = 'p_rahul'");
    expect(r.rows[0].stripe_customer_id).toBe('cus_1');
    expect(stripe.customers).toEqual(['cus_1']);
  });

  it('keeps only the sealed token and what the page shows', async () => {
    const { saved } = await addCard('p_rahul');
    expect(saved).toMatchObject({ ok: true, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
    if (!saved.ok) throw new Error('not saved');
    expect(await openCardRef(pool, master, 'p_rahul', saved.card.card_id)).toBe('pm_card_visa');
    const row = await pool.query<{ sealed: Buffer }>('select sealed from cards where card_id = $1', [saved.card.card_id]);
    expect(row.rows[0]?.sealed.includes(Buffer.from('pm_card_visa'))).toBe(false);
    expect(await newestCard(pool, 'p_rahul')).toEqual(saved.card);
    expect(await listCards(pool, 'p_rahul')).toEqual([saved.card]);
    const log = await pool.query("select kind, card_id from unlock_log where person_id = 'p_rahul'");
    expect(log.rows).toContainEqual({ kind: 'card_added', card_id: saved.card.card_id });
  });

  it('refuses a setup Stripe has not finished', async () => {
    const { clientSecret } = await startCardSetup(pool, stripe, 'p_rahul', now);
    const setupIntentId = clientSecret.split('_secret_')[0] as string;
    expect(await saveCardFromSetup(pool, stripe, master, now, { personId: 'p_rahul', setupIntentId })).toEqual({ ok: false, reason: 'not_finished' });
    expect(await saveCardFromSetup(pool, stripe, master, now, { personId: 'p_rahul', setupIntentId: 'seti_unknown' })).toEqual({ ok: false, reason: 'not_finished' });
  });

  it("refuses someone else's card setup", async () => {
    const { clientSecret } = await startCardSetup(pool, stripe, 'p_priya', now);
    const setupIntentId = clientSecret.split('_secret_')[0] as string;
    stripe.completeSetup(setupIntentId);
    expect(await saveCardFromSetup(pool, stripe, master, now, { personId: 'p_rahul', setupIntentId })).toEqual({ ok: false, reason: 'not_yours' });
  });

  it('does not open a card row moved to another person', async () => {
    const { saved } = await addCard('p_rahul');
    if (!saved.ok) throw new Error('not saved');
    await pool.query("update cards set person_id = 'p_priya' where card_id = $1", [saved.card.card_id]);
    await expect(openCardRef(pool, master, 'p_priya', saved.card.card_id)).rejects.toThrow();
  });
});

describe('nothing that looks like a card number', () => {
  it('appears in any column of the vault after cards were added', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = $1 and data_type in ('text', 'character varying', 'jsonb', 'ARRAY')`,
      [schema],
    );
    for (const c of cols.rows) {
      const hits = await pool.query(`select count(*)::int as n from ${c.table_name} where ${c.column_name}::text ~ '[0-9]{13,19}'`);
      expect({ at: `${c.table_name}.${c.column_name}`, n: hits.rows[0].n }).toEqual({ at: `${c.table_name}.${c.column_name}`, n: 0 });
    }
  });
});

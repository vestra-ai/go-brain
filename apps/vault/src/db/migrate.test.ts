import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from './migrate.js';
import { withVaultSchema } from './test-db.js';

let pool: pg.Pool;
let schema: string;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ pool, schema, drop } = await withVaultSchema());
});
afterAll(async () => {
  await drop();
});

describe('vault migrations', () => {
  it('creates every table', async () => {
    const r = await pool.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1 order by table_name',
      [schema],
    );
    expect(r.rows.map((x) => x.table_name)).toEqual([
      'cards', 'challenges', 'internal_seen', 'links', 'passkeys', 'pay_requests',
      'unlock_log', 'used_approvals', 'vault_migrations', 'vault_people', 'voided_approvals',
    ]);
  });

  it('applies nothing the second time', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('has no column that could hold a card number, a CVV or a password in the clear', async () => {
    const r = await pool.query<{ column_name: string }>(
      'select column_name from information_schema.columns where table_schema = $1',
      [schema],
    );
    const names = r.rows.map((x) => x.column_name);
    expect(names.filter((n) => /pan|card_number|number|cvv|cvc|password|secret/.test(n))).toEqual([]);
  });

  it('keeps last4 to four digits, so a full number cannot be stored there', async () => {
    await pool.query("insert into vault_people (person_id, created_at) values ('p_rahul', now())");
    await expect(
      pool.query(
        "insert into cards (card_id, person_id, brand, last4, exp_month, exp_year, sealed, created_at) values ('cd_1', 'p_rahul', 'visa', '4242424242424242', 12, 2030, '\\x01', now())",
      ),
    ).rejects.toThrow(/cards_last4_check/);
  });
});

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.js';

/** A fresh schema holding the vault's tables, for one test file. Uses the CI Postgres in DATABASE_URL. */
export async function withVaultSchema(): Promise<{ pool: pg.Pool; schema: string; drop: () => Promise<void> }> {
  const url = process.env.VAULT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: the vault tests need Postgres');
  const schema = `vault_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${schema}` });
  await migrate(pool);
  return {
    pool,
    schema,
    drop: async () => {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    },
  };
}

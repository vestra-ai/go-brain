import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

/**
 * A fresh schema for one test file with every migration applied. Every lane's database tests use it:
 *
 *   let db: Awaited<ReturnType<typeof withSchema>>;
 *   beforeAll(async () => { db = await withSchema(); });
 *   afterAll(() => db.drop());
 */
export async function withSchema(): Promise<{ pool: pg.Pool; schema: string; drop: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: tests that need Postgres run in CI (.github/workflows/ci.yml)');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`create schema ${schema}`);
  } finally {
    await admin.end();
  }
  const pool = createPool(url, { schema, max: 10 });
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

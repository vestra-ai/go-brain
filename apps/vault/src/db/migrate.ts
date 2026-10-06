import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';

const DIR = new URL('./migrations/', import.meta.url);
const LOCK = 4100;

/** Runs every migration file once, in name order. Returns the files it applied. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK]);
    await client.query(
      'create table if not exists vault_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query<{ name: string }>('select name from vault_migrations')).rows.map((r) => r.name));
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, DIR), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into vault_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
    client.release();
  }
}

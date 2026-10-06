import { readdirSync, readFileSync } from 'node:fs';
import type pg from 'pg';

const DIR = new URL('./migrations/', import.meta.url);

/**
 * Migration files are NNNN_name.sql, numbered by lane: A 1xxx, B 2xxx, C 3xxx, D 4xxx, P6 5xxx, P3 6xxx.
 * They run in name order and are never edited once applied.
 */
export function migrationFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

/** Applies every migration not applied yet, each in its own transaction. Returns the names applied. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    // Several copies of the service may boot at once; one migrates, the others wait.
    await c.query(`select pg_advisory_lock(hashtext('go_migrate:' || current_schema()))`);
    await c.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const { rows } = await c.query<{ name: string }>('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of migrationFiles()) {
      const name = file.replace(/\.sql$/, '');
      if (done.has(name)) continue;
      await c.query('begin');
      try {
        await c.query(readFileSync(new URL(file, DIR), 'utf8'));
        await c.query('insert into schema_migrations (name) values ($1)', [name]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await c.query(`select pg_advisory_unlock(hashtext('go_migrate:' || current_schema()))`).catch(() => undefined);
    c.release();
  }
}

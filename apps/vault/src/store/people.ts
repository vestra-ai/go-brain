import type pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;

/** One vault per person, keyed by the person_id the Server gives Go. */
export async function ensurePerson(db: Db, personId: string, now: Date, displayName?: string): Promise<void> {
  await db.query(
    `insert into vault_people (person_id, display_name, created_at) values ($1, $2, $3)
     on conflict (person_id) do update set display_name = coalesce(excluded.display_name, vault_people.display_name)`,
    [personId, displayName ?? null, now],
  );
}

export async function personName(db: Db, personId: string): Promise<string | null> {
  const r = await db.query<{ display_name: string | null }>('select display_name from vault_people where person_id = $1', [personId]);
  return r.rows[0]?.display_name ?? null;
}

export async function customerIdOf(db: Db, personId: string): Promise<string | null> {
  const r = await db.query<{ stripe_customer_id: string | null }>(
    'select stripe_customer_id from vault_people where person_id = $1',
    [personId],
  );
  return r.rows[0]?.stripe_customer_id ?? null;
}

/**
 * Facts about people, each with its proof. One current fact per person, topic and trip: a new fact
 * replaces the old one by lookup, and the old one stays underneath as history (superseded_by).
 */
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Anything that can run a query: the pool or a client inside a transaction. */
export type Db = Pick<Pool, 'query'>;

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export type Audience = 'group' | 'go';
export type FactSource = 'message' | 'join' | 'note';
/** About the person, so carry-over may show it in their next trips; or about this trip only (memory/pages.ts). */
export type FactScope = 'person' | 'trip';
export interface FactRow {
  factId: string;
  personId: string;
  tripId: string;
  topic: string;
  text: string;
  messageId: string | null;
  saidAt: Date;
  audience: Audience;
  source: FactSource;
}
export type NewFact = Omit<FactRow, 'factId'> & { scope?: FactScope };

interface FactDbRow {
  fact_id: string;
  person_id: string;
  trip_id: string;
  topic: string;
  text: string;
  message_id: string | null;
  said_at: Date;
  audience: Audience;
  source: FactSource;
}
const COLS = 'fact_id, person_id, trip_id, topic, text, message_id, said_at, audience, source';
const toFact = (r: FactDbRow): FactRow => ({
  factId: r.fact_id, personId: r.person_id, tripId: r.trip_id, topic: r.topic, text: r.text,
  messageId: r.message_id, saidAt: r.said_at, audience: r.audience, source: r.source,
});

export function newFactId(): string {
  return `f_${randomBytes(12).toString('hex')}`;
}

export function normTopic(t: string): string {
  const s = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/g, '');
  return s || 'other';
}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One person's writes and their forget take turns: saveFact and forget_person both take this lock inside their
 * transaction, so a save that started before a forget either lands before it (and the forget removes it) or
 * sees the forget and refuses.
 */
export async function lockPerson(db: Db, personId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('person:' || $1))`, [personId]);
}

interface ChainRow {
  fact_id: string;
  text: string;
  said_at: Date;
  superseded_by: string | null;
}

/** One topic's chain, oldest first, ending at the current fact. */
function chainOf(rows: ChainRow[], current: ChainRow): ChainRow[] {
  const before = new Map<string, ChainRow>(rows.flatMap((r): Array<[string, ChainRow]> => (r.superseded_by ? [[r.superseded_by, r]] : [])));
  const chain = [current];
  for (let r = before.get(current.fact_id); r && chain.length <= rows.length; r = before.get(r.fact_id)) chain.unshift(r);
  return chain;
}

export type SaveResult = { factId: string; changed: boolean } | { factId: null; changed: false; refused: 'forgotten' };

export async function saveFact(pool: Pool, f: NewFact): Promise<SaveResult> {
  const topic = normTopic(f.topic);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTx(pool, async (c): Promise<SaveResult> => {
        await lockPerson(c, f.personId);
        if (f.messageId !== null) {
          // A forget for this trip covers every message up to its change number. A proof the messages table does not
          // know cannot be placed after the forget, so it is refused too.
          const gone = await c.query<{ up_to_seq: number; seq: number | null }>(
            `SELECT g.up_to_seq, m.seq FROM forgotten g
               LEFT JOIN messages m ON m.trip_id = g.trip_id AND m.message_id = $3
              WHERE g.person_id = $1 AND g.trip_id = $2`,
            [f.personId, f.tripId, f.messageId],
          );
          const g = gone.rows[0];
          if (g && (g.seq === null || g.up_to_seq >= g.seq)) return { factId: null, changed: false, refused: 'forgotten' };
        }
        const rows = await c.query<ChainRow>(
          `SELECT fact_id, text, said_at, superseded_by FROM facts
            WHERE person_id = $1 AND trip_id = $2 AND topic = $3 FOR UPDATE`,
          [f.personId, f.tripId, topic],
        );
        const old = rows.rows.find((r) => r.superseded_by === null);
        if (old && sameText(old.text, f.text)) return { factId: old.fact_id, changed: false };
        const factId = newFactId();
        if (old && old.said_at.getTime() > f.saidAt.getTime()) {
          // Said before the current fact (a late notes pass, a re-read): it joins the history at its place in time,
          // and the newer fact stays current.
          const chain = chainOf(rows.rows, old);
          const at = chain.findIndex((r) => r.said_at.getTime() > f.saidAt.getTime());
          const next = chain[at]!;
          const prev = at > 0 ? chain[at - 1] : undefined;
          await c.query(`INSERT INTO facts (${COLS}, superseded_by, scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
            factId, f.personId, f.tripId, topic, f.text, f.messageId, f.saidAt, f.audience, f.source, next.fact_id, f.scope ?? 'person',
          ]);
          if (prev) await c.query('UPDATE facts SET superseded_by = $1 WHERE fact_id = $2', [factId, prev.fact_id]);
          return { factId, changed: false };
        }
        if (old) await c.query('UPDATE facts SET superseded_by = $1 WHERE fact_id = $2', [factId, old.fact_id]);
        await c.query(`INSERT INTO facts (${COLS}, scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
          factId, f.personId, f.tripId, topic, f.text, f.messageId, f.saidAt, f.audience, f.source, f.scope ?? 'person',
        ]);
        return { factId, changed: true };
      });
    } catch (err) {
      // Two saves raced on a topic with no current fact; the unique index refused one. Once more.
      if (attempt === 0 && (err as { code?: string }).code === '23505') continue;
      throw err;
    }
  }
}

export async function currentFacts(db: Db, where: { personId: string; tripId?: string }): Promise<FactRow[]> {
  const r = await db.query<FactDbRow>(
    `SELECT ${COLS} FROM facts
      WHERE person_id = $1 AND superseded_by IS NULL AND ($2::text IS NULL OR trip_id = $2)
      ORDER BY said_at DESC, fact_id LIMIT 500`,
    [where.personId, where.tripId ?? null],
  );
  return r.rows.map(toFact);
}

/** Deletes one row; whatever it replaced takes its place in the chain (an older fact can become current again). */
async function deleteRow(c: Db, factId: string): Promise<void> {
  const r = await c.query<{ superseded_by: string | null }>('DELETE FROM facts WHERE fact_id = $1 RETURNING superseded_by', [factId]);
  const gone = r.rows[0];
  if (!gone) return;
  await c.query('UPDATE facts SET superseded_by = $1 WHERE superseded_by = $2', [gone.superseded_by, factId]);
}

export async function deleteFactRow(pool: Pool, factId: string): Promise<void> {
  await withTx(pool, (c) => deleteRow(c, factId));
}

/** A deleted (or edited) message takes back what Go learned from it. */
export async function dropFactsFromMessage(pool: Pool, tripId: string, messageId: string): Promise<number> {
  return withTx(pool, async (c) => {
    const ids = await c.query<{ fact_id: string }>(
      'SELECT fact_id FROM facts WHERE trip_id = $1 AND message_id = $2 ORDER BY created_at DESC FOR UPDATE',
      [tripId, messageId],
    );
    for (const { fact_id } of ids.rows) await deleteRow(c, fact_id);
    return ids.rows.length;
  });
}

/** The person removed a fact from their page: it goes with its history, nothing comes back. */
export async function deleteFactChain(pool: Pool, personId: string, factId: string): Promise<number> {
  const r = await pool.query<{ fact_id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT fact_id FROM facts WHERE fact_id = $2 AND person_id = $1
       UNION
       SELECT f.fact_id FROM facts f JOIN chain ON f.superseded_by = chain.fact_id
     )
     DELETE FROM facts WHERE fact_id IN (SELECT fact_id FROM chain) RETURNING fact_id`,
    [personId, factId],
  );
  return r.rowCount ?? 0;
}

/** Deletes every row about the person (one trip, or all with null). Returns how many current facts went. */
export async function forgetFacts(db: Db, personId: string, tripId: string | null): Promise<number> {
  const r = await db.query<{ superseded_by: string | null }>(
    'DELETE FROM facts WHERE person_id = $1 AND ($2::text IS NULL OR trip_id = $2) RETURNING superseded_by',
    [personId, tripId],
  );
  return r.rows.filter((x) => x.superseded_by === null).length;
}

/** Every row about the person, history included. Forget checks this is 0. */
export async function countFacts(db: Db, personId: string, tripId: string | null): Promise<number> {
  const r = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM facts WHERE person_id = $1 AND ($2::text IS NULL OR trip_id = $2)',
    [personId, tripId],
  );
  return r.rows[0]!.n;
}

export async function getCarryOver(db: Db, personId: string): Promise<boolean> {
  const r = await db.query<{ carry_over: boolean }>('SELECT carry_over FROM people WHERE person_id = $1', [personId]);
  return r.rows[0]?.carry_over ?? false;
}

export async function setCarryOver(db: Db, personId: string, on: boolean): Promise<void> {
  await db.query(
    `INSERT INTO people (person_id, carry_over, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (person_id) DO UPDATE SET carry_over = EXCLUDED.carry_over, updated_at = now()`,
    [personId, on],
  );
}

export async function markForgotten(db: Db, personId: string, tripId: string, upToSeq: number, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO forgotten (person_id, trip_id, up_to_seq, forgotten_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (person_id, trip_id)
     DO UPDATE SET up_to_seq = GREATEST(forgotten.up_to_seq, EXCLUDED.up_to_seq), forgotten_at = EXCLUDED.forgotten_at`,
    [personId, tripId, upToSeq, at],
  );
}

export async function forgottenUpTo(db: Db, tripId: string): Promise<Map<string, number>> {
  const r = await db.query<{ person_id: string; up_to_seq: number }>('SELECT person_id, up_to_seq FROM forgotten WHERE trip_id = $1', [tripId]);
  return new Map(r.rows.map((x) => [x.person_id, x.up_to_seq]));
}

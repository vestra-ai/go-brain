/**
 * The Server's people requests: "What Go knows about you" (get_person), the carry-over switch
 * (update_person), removing one fact (delete_fact) and "Forget me" (forget_person). Every answer is
 * validated against the contract before it leaves. Forget answers remaining_facts: 0 only after queries
 * show no fact, no story line and a forgotten mark for every trip.
 */
import * as C from '@go/contract';
import type { Pool } from 'pg';
import type { ToGoHandler } from '../door/handlers.js';
import { SocketCallError } from '../door/rpc.js';
import type { Log } from '../log.js';
import type { Packs } from '../trips/pack.js';
import {
  countFacts, currentFacts, deleteFactChain, forgetFacts, getCarryOver, lockPerson, markForgotten, setCarryOver, withTx, type Db, type FactRow,
} from './facts.js';
import type { Fold } from './fold.js';

/**
 * catch_up before the real one (Task 13, a stretch built after G2) lands: a valid answer with nothing in it, at once.
 * The person simply sees no "while you were away" above the room; the Server never gets -32601.
 */
export function emptyCatchUp(): ToGoHandler<'catch_up'> {
  return async () => C.CatchUp.parse({ items: [] });
}

/**
 * A person has one current fact per topic (guide 05). Facts are kept per trip, so the person's page
 * answers the newest one on each topic across their trips. `facts` must be newest first (currentFacts is).
 */
export function newestPerTopic(facts: FactRow[]): FactRow[] {
  const byTopic = new Map<string, FactRow>();
  for (const f of facts) if (!byTopic.has(f.topic)) byTopic.set(f.topic, f);
  return [...byTopic.values()];
}

export interface PeopleDeps {
  pool: Pool;
  packs: Packs;
  fold: Pick<Fold, 'redactPerson' | 'storyMentions'>;
  now: () => Date;
  log: Log;
}

/** Every trip Go holds anything about this person in. */
async function tripsOf(db: Db, personId: string): Promise<string[]> {
  const r = await db.query<{ trip_id: string }>(
    `SELECT trip_id FROM facts WHERE person_id = $1
     UNION SELECT trip_id FROM messages WHERE person_id = $1
     UNION SELECT trip_id FROM story_lines WHERE people @> ARRAY[$1]::text[]`,
    [personId],
  );
  return r.rows.map((x) => x.trip_id).sort();
}

async function lastSeq(db: Db, tripId: string): Promise<number> {
  const r = await db.query<{ n: number }>('SELECT coalesce(max(seq), 0)::int AS n FROM messages WHERE trip_id = $1', [tripId]);
  return r.rows[0]!.n;
}

/** The person's names in these trips, to find story lines that name them without a tag. */
async function namesOf(packs: Packs, personId: string, tripIds: string[]): Promise<string[]> {
  const names = await Promise.all(
    tripIds.slice(0, 20).map(async (t) => {
      try {
        return (await packs.get(t)).trip.people.find((p) => p.person_id === personId)?.name ?? null;
      } catch {
        return null;
      }
    }),
  );
  return [...new Set(names.filter((n): n is string => n !== null))];
}

const notForgotten = () => new SocketCallError(500, 'Go could not forget everything; nothing was changed. Try again.', 'internal');

export function peopleHandlers(d: PeopleDeps): {
  get_person: ToGoHandler<'get_person'>;
  update_person: ToGoHandler<'update_person'>;
  delete_fact: ToGoHandler<'delete_fact'>;
  forget_person: ToGoHandler<'forget_person'>;
} {
  return {
    async get_person({ person_id }) {
      const [carry, facts] = await Promise.all([getCarryOver(d.pool, person_id), currentFacts(d.pool, { personId: person_id })]);
      return C.PersonPage.parse({
        person_id,
        carry_over: carry,
        facts: newestPerTopic(facts).map((f) => ({
          fact_id: f.factId,
          topic: f.topic,
          text: f.text,
          trip_id: f.tripId,
          message_id: f.messageId,
          said_at: f.saidAt.toISOString(),
        })),
      });
    },

    async update_person({ person_id, carry_over }) {
      await setCarryOver(d.pool, person_id, carry_over);
      return C.Ok.parse({ ok: true });
    },

    async delete_fact({ person_id, fact_id }) {
      const removed = await deleteFactChain(d.pool, person_id, fact_id);
      if (removed === 0) throw new SocketCallError(404, 'That fact is already gone.', 'not_found');
      return C.Ok.parse({ ok: true });
    },

    async forget_person({ person_id, trip_id }) {
      const tripId = trip_id ?? null;
      const trips = tripId ? [tripId] : await tripsOf(d.pool, person_id);
      const names = await namesOf(d.packs, person_id, trips);
      const deleted = await withTx(d.pool, async (c) => {
        // The same lock saveFact takes: a notes pass that is saving for this person waits, then sees the forget.
        await lockPerson(c, person_id);
        const n = await forgetFacts(c, person_id, tripId);
        for (const t of trips) await markForgotten(c, person_id, t, await lastSeq(c, t), d.now());
        await d.fold.redactPerson(c, person_id, trips, names);
        // Checked by query inside the transaction: anything left rolls everything back.
        if ((await countFacts(c, person_id, tripId)) !== 0) throw notForgotten();
        if ((await d.fold.storyMentions(c, person_id, trips, names)) !== 0) throw notForgotten();
        return n;
      });
      // And once more after the commit, against what other readers will see.
      const marks = await d.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM forgotten WHERE person_id = $1 AND trip_id = ANY($2::text[])',
        [person_id, trips],
      );
      if ((await countFacts(d.pool, person_id, tripId)) !== 0 || marks.rows[0]!.n !== trips.length) throw notForgotten();
      d.log.info({ personId: person_id, trips: trips.length, deleted }, 'forgot a person');
      return C.ForgetResult.parse({ deleted_facts: deleted, remaining_facts: 0 });
    },
  };
}

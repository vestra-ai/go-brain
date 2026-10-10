/**
 * Forget me in one trip reaches the person's other trips (staging, 10 Oct: Kabir used it in his first trip, and in his
 * second Go still said "Kabir has a bad knee", read off its own earlier message there, which carry-over had fed). When
 * the person had carry-over on, every other trip they are in is marked, and its turns are told never to repeat, from
 * Go's own earlier messages, anything about them: only what they or the group say there, and the facts "right now" shows.
 */
import type { NowProvider } from '../composer/context.js';
import { personName } from '../composer/fence.js';
import type { Packs } from '../trips/pack.js';
import type { Db } from './facts.js';

export async function markForgotElsewhere(db: Db, personId: string, trips: readonly string[], forgotIn: string, at: Date): Promise<void> {
  for (const tripId of trips) {
    if (tripId === forgotIn) continue;
    await db.query(
      `INSERT INTO forgot_elsewhere (person_id, trip_id, forgot_in, marked_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (person_id, trip_id, forgot_in) DO UPDATE SET marked_at = EXCLUDED.marked_at`,
      [personId, tripId, forgotIn, at],
    );
  }
}

export async function forgotElsewhere(db: Db, tripId: string): Promise<string[]> {
  const r = await db.query<{ person_id: string }>('SELECT DISTINCT person_id FROM forgot_elsewhere WHERE trip_id = $1 ORDER BY person_id', [tripId]);
  return r.rows.map((x) => x.person_id);
}

/** Said under "right now" in a trip where someone in it used Forget me in another trip. */
export function forgotElsewhereNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const them = names.length === 1 ? who : 'them';
  return (
    `${who} had Go forget what it learned about them in another trip, and your own earlier messages here may repeat it. ` +
    `Never repeat anything about ${them} from your own earlier messages in this chat: use only what they or the group say in this trip, ` +
    `and what "right now" shows. Never mention the forget.`
  );
}

export function forgotElsewhereNow(d: { pool: Db; packs: Pick<Packs, 'get'> }): NowProvider {
  return {
    name: 'forgot elsewhere',
    order: 23,
    async render(tripId) {
      const ids = await forgotElsewhere(d.pool, tripId);
      if (ids.length === 0) return null;
      const pack = await d.packs.get(tripId);
      const names = ids.flatMap((id) => {
        const p = pack.trip.people.find((x) => x.person_id === id);
        return p ? [personName(p.name)] : [];
      });
      return forgotElsewhereNote(names);
    },
  };
}

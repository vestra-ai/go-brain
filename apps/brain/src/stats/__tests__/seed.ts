// Rows shaped like the ones P1 writes, for the stats and board tests.
import type pg from 'pg';

export const NOW = new Date('2026-10-08T18:00:00Z');
export const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);
let n = 0;

export async function seedTrip(pool: pg.Pool, tripId: string): Promise<void> {
  await pool.query('insert into trips (trip_id, created_at) values ($1, $2) on conflict (trip_id) do nothing', [tripId, NOW]);
}

async function messageEvent(pool: pg.Pool, tripId: string, author: Record<string, unknown>, at: Date): Promise<string> {
  n += 1;
  const messageId = `m_seed_${n}`;
  const ev = { event_id: `ev_seed_${n}`, trip_id: tripId, seq: n, occurred_at: at.toISOString(), type: 'message.created', data: { message: { message_id: messageId, author } } };
  await pool.query('insert into trip_events (event_id, trip_id, seq, type, payload, received_at) values ($1, $2, $3, $4, $5, $6)', [ev.event_id, tripId, n, ev.type, JSON.stringify(ev), at]);
  return messageId;
}
export const personMessage = (pool: pg.Pool, o: { tripId?: string; at: Date }): Promise<string> =>
  messageEvent(pool, o.tripId ?? 't_goa', { kind: 'person', person_id: 'p_priya' }, o.at);
export const goMessage = (pool: pg.Pool, o: { tripId?: string; at: Date }): Promise<string> => messageEvent(pool, o.tripId ?? 't_goa', { kind: 'go' }, o.at);

export interface SeedTurn {
  id: string;
  tripId?: string;
  /** Minutes before NOW the waking message landed (or the turn started, when `message` is false). */
  at: number;
  /** Woken by a person's message (default) or by something else, such as setup. */
  message?: boolean;
  /** Whether that message named Go (default true): the board times only turns a message named Go in. */
  namesGo?: boolean;
  /** A chatter line that landed this long before the waking message and joined the same turn. */
  chatterBeforeMs?: number;
  /** The desk's wait before the turn began. */
  waitMs?: number;
  /** Times after the landing. */
  typingMs?: number;
  postedMs?: number;
  model?: string;
  rounds?: number;
  input?: number;
  cached?: number;
  written?: number;
  cost?: number;
}

/** A turn as P1 records it, with its waking message event and desk item when it has one. */
export async function seedTurn(pool: pg.Pool, o: SeedTurn): Promise<void> {
  const tripId = o.tripId ?? 't_goa';
  const landed = minutesAgo(o.at);
  const after = (ms: number | undefined): Date | null => (ms === undefined ? null : new Date(landed.getTime() + ms));
  const byMessage = o.message ?? true;
  const deskItem = async (at: Date, namesGo: boolean): Promise<void> => {
    const messageId = await personMessage(pool, { tripId, at });
    await pool.query(
      "insert into desk_items (id, trip_id, kind, ref, due_at, payload, turn_id, done_at) values ($1, $2, 'message', $3, $4, $5, $6, $4)",
      [`msg:${tripId}:${messageId}`, tripId, messageId, at, JSON.stringify({ messageId, namesGo }), o.id],
    );
  };
  if (byMessage && o.chatterBeforeMs !== undefined) await deskItem(new Date(landed.getTime() - o.chatterBeforeMs), false);
  if (byMessage) await deskItem(landed, o.namesGo ?? true);
  await pool.query(
    `insert into turns (turn_id, trip_id, woke_for, started_at, typing_at, posted_at, model, rounds, input_tokens, cached_tokens, cache_write_tokens, output_tokens, cost_usd, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      o.id, tripId, byMessage ? ['message'] : ['setup'], after(o.waitMs ?? 0), after(o.typingMs), after(o.postedMs), o.model ?? 'claude-sonnet-5-5',
      o.rounds ?? 1, o.input ?? 0, o.cached ?? 0, o.written ?? 0, 20, o.cost ?? 0, o.postedMs === undefined ? 'silent' : 'spoke',
    ],
  );
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query('truncate table turns, desk_items, trip_events, go_requests, bench_reports cascade');
}

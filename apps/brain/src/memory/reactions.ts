/** Every reaction Go sends (the reflex, the notes pass, the composer's react tool): at most one per message and emoji, with a request_id derived from them. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Message } from '../door/methods.js';
import { SocketCallError } from '../door/rpc.js';
import type { ServerLink } from '../door/server-link.js';

/** The same trip, message and emoji always give the same request_id, so a retry after a crash is done once. */
export function reactionRequestId(tripId: string, messageId: string, emoji: string): string {
  return `go_react_${createHash('sha256').update(`${tripId}|${messageId}|${emoji}`).digest('hex').slice(0, 24)}`;
}

/** The request_id for taking Go's ✅ back from a message it asked about instead. */
function takeBackRequestId(tripId: string, messageId: string): string {
  return reactionRequestId(tripId, messageId, '✅').replace(/^go_react_/, 'go_unreact_');
}

type Outcome = 'sent' | 'skipped' | 'failed';

/**
 * Work on one message and emoji runs one job at a time in this process, by request id: a second ✅ waits for the first
 * and then finds it done, and Go taking a ✅ back never interleaves with one being sent.
 */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

export function reactOnce(pool: Pool, link: ServerLink, tripId: string, message: Message, emoji: string): Promise<Outcome> {
  return oneAtATime(reactionRequestId(tripId, message.message_id, emoji), () => sendOnce(pool, link, tripId, message, emoji));
}

/**
 * Go asked about this message instead of noting it, so no ✅ goes on it: one already sent (the reflex is quicker than a
 * turn) is taken back, and the row marks it done so a later ✅ (the notes pass, a rerun) is skipped. 'held' when no ✅
 * had gone out.
 */
export function withholdCheck(pool: Pool, link: ServerLink, tripId: string, messageId: string): Promise<'held' | 'taken_back'> {
  const off = takeBackRequestId(tripId, messageId);
  return oneAtATime(reactionRequestId(tripId, messageId, '✅'), async () => {
    const fresh = await pool.query(
      `INSERT INTO go_reactions (trip_id, message_id, emoji, request_id, done_at) VALUES ($1, $2, '✅', $3, now())
       ON CONFLICT (trip_id, message_id, emoji) DO NOTHING`,
      [tripId, messageId, off],
    );
    if (fresh.rowCount === 1) return 'held';
    const row = (
      await pool.query<{ request_id: string }>(
        `SELECT request_id FROM go_reactions WHERE trip_id = $1 AND message_id = $2 AND emoji = '✅'`,
        [tripId, messageId],
      )
    ).rows[0];
    if (row?.request_id === off) return 'held';
    // A ✅ went out, or may have (a send whose answer never came): mark the row taken back, then take it back.
    await pool.query(
      `UPDATE go_reactions SET request_id = $3, done_at = coalesce(done_at, now()) WHERE trip_id = $1 AND message_id = $2 AND emoji = '✅'`,
      [tripId, messageId, off],
    );
    try {
      await link.request('remove_reaction', { request_id: off, trip_id: tripId, message_id: messageId, emoji: '✅' });
    } catch (err) {
      // 404, 409 and 422: no ✅ there, or no message any more. Anything else goes up to the turn, which logs it.
      if (!(err instanceof SocketCallError && [404, 409, 422].includes(err.code))) throw err;
    }
    return 'taken_back';
  });
}

async function sendOnce(pool: Pool, link: ServerLink, tripId: string, message: Message, emoji: string): Promise<Outcome> {
  if (message.author.kind !== 'person' || message.deleted || message.withheld) return 'skipped';
  if (message.reactions.some((r) => r.person_id == null && r.emoji === emoji)) return 'skipped';
  await pool.query(
    `INSERT INTO go_reactions (trip_id, message_id, emoji, request_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (trip_id, message_id, emoji) DO NOTHING`,
    [tripId, message.message_id, emoji, reactionRequestId(tripId, message.message_id, emoji)],
  );
  const row = (
    await pool.query<{ request_id: string; done_at: Date | null }>(
      'SELECT request_id, done_at FROM go_reactions WHERE trip_id = $1 AND message_id = $2 AND emoji = $3',
      [tripId, message.message_id, emoji],
    )
  ).rows[0]!;
  if (row.done_at) return 'skipped';
  const markDone = () =>
    pool.query('UPDATE go_reactions SET done_at = now() WHERE trip_id = $1 AND message_id = $2 AND emoji = $3', [tripId, message.message_id, emoji]);
  try {
    await link.request('add_reaction', { request_id: row.request_id, trip_id: tripId, message_id: message.message_id, emoji });
  } catch (err) {
    // 409: already reacted or the message was deleted; 404 and 422: nothing to retry.
    if (err instanceof SocketCallError && [404, 409, 422].includes(err.code)) {
      await markDone();
      return 'skipped';
    }
    return 'failed';
  }
  await markDone();
  return 'sent';
}
